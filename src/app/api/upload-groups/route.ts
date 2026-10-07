import { NextRequest, NextResponse } from 'next/server';
import { list } from '@vercel/blob';
import { fetchBlobJson } from '@/lib/blob-utils';
import { downloadBlobJson } from '@/lib/blob-download';
import { reconcileGeminiStatus } from '@/lib/processing-status';
import { activeRunsFor, type ActiveRun } from '@/lib/workflow/store';
// import { getUserIdentifier } from '@/lib/auth'; // Uncomment if you need per-user filtering

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // Disable caching
export const revalidate = 0; // No caching

const METADATA_CONCURRENCY = 10;

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

interface UploadGroupMetadata {
  id: string;
  uploadDate: string;
  userId?: string;
  userEmail?: string;
  files: Array<{
    name: string;
    url: string;
    size: number;
    type: string;
  }>;
  totalSize: number;
  geminiProcessing?: {
    status: 'processing' | 'completed' | 'error' | 'partial';
    extractedContent?: string;
    processedAt?: string;
    error?: string;
    fileCount?: number;
  };
  workflowRun?: ActiveRun;
  archived?: { at: string; by?: string };
}

/**
 * What the document LIST actually needs. The stored metadata carries
 * `geminiProcessing.extractedContent` — the full extracted text of every PDF in
 * the group, often hundreds of KB — plus each file's blob URL and size. None of
 * it is read by the list UI, yet it shipped on every list load, every poll tick
 * while a group processes, and (because the detail view fetched the whole list)
 * every group open. Project it away here; `GET /api/upload-groups/[id]` serves
 * the full record when a single group is actually opened.
 */
function toListItem(gRaw: UploadGroupMetadata) {
  // Self-heal a group whose completion write was clobbered back to "processing"
  // by a concurrent stale-read write, so the card doesn't show a stalled banner
  // for a group that actually finished.
  const g = reconcileGeminiStatus(gRaw);
  return {
    id: g.id,
    uploadDate: g.uploadDate,
    userId: g.userId,
    userEmail: g.userEmail,
    // Names drive the file counts on the card.
    files: (g.files ?? []).map((f) => ({ name: f.name, type: f.type })),
    totalSize: g.totalSize,
    geminiProcessing: g.geminiProcessing
      ? {
          status: g.geminiProcessing.status,
          processedAt: g.geminiProcessing.processedAt,
          error: g.geminiProcessing.error,
          fileCount: g.geminiProcessing.fileCount,
        }
      : undefined,
    workflowRun: g.workflowRun,
    archived: g.archived,
    summaryNote: (g as { summaryNote?: unknown }).summaryNote,
  };
}

export async function GET(request: NextRequest) {
  try {
    // Get user session
    // const userIdentifier = await getUserIdentifier(); // Uncomment if you need per-user filtering
    
    // List all upload group metadata files from Blob storage
    // Try both old and new structures
    const { blobs: newFormatBlobs } = await list({
      prefix: 'upload-groups/',
    });


    // Combine both formats during transition period
    const blobs = newFormatBlobs;

    // Fetch and parse metadata for each upload group
    const groups: UploadGroupMetadata[] = [];
    
    // Filter for metadata.json files only (not individual files)
    // Support both old format (upload-groups/metadata/{id}.json) and new format (upload-groups/{id}/metadata.json)
    const metadataBlobs = blobs.filter(blob => 
      blob.pathname.endsWith('.json') && 
      (blob.pathname.includes('/metadata/') || blob.pathname.endsWith('/metadata.json'))
    );
    
    console.log(`[UploadGroups] Metadata blobs found: ${metadataBlobs.length}`);
    
    {
      // Load each group's metadata concurrently (bounded). This was a serial
      // for…await, so a workspace of N groups paid N sequential blob round-trips
      // before the response could start.
      await mapWithConcurrency(metadataBlobs, METADATA_CONCURRENCY, async (blob) => {
        try {
          // Try different methods to fetch the metadata
          let metadata: UploadGroupMetadata | null = null;
          
          // Method 1: Try using downloadUrl or url with fetchBlobJson
          // list() already gave us a download URL, so skip the head() pre-flight.
          const urlToFetch = blob.downloadUrl || blob.url;
          try {
            metadata = await fetchBlobJson<UploadGroupMetadata>(urlToFetch, { skipHead: !!blob.downloadUrl });
          } catch (fetchError) {
            // Method 2: Try using the download API with pathname
            try {
              metadata = await downloadBlobJson<UploadGroupMetadata>(blob.pathname);
            } catch {
              throw fetchError; // Re-throw original error
            }
          }
          
          if (!metadata) {
            throw new Error('Failed to fetch metadata with all methods');
          }
          
          // Optional: Filter by user if needed
          // if (session?.user?.email && metadata.userEmail !== session.user.email) {
          //   continue;
          // }
          
          groups.push(metadata);
        } catch (error) {
          console.error(`[UploadGroups] Error fetching metadata for ${blob.pathname}:`, error);
          
          // Extract group ID from the blob pathname
          const pathParts = blob.pathname.split('/');
          let groupId: string | null = null;
          
          // Try different path patterns
          if (blob.pathname.includes('/metadata.json')) {
            // New format: upload-groups/{groupId}/metadata.json
            groupId = pathParts[pathParts.length - 2];
          } else if (blob.pathname.includes('/metadata/')) {
            // Old format: upload-groups/metadata/{groupId}.json
            const filename = pathParts[pathParts.length - 1];
            groupId = filename.replace('.json', '');
          }
          
          if (groupId) {
            const isDevelopment = process.env.NODE_ENV === 'development';
            
            // Try a direct fetch with constructed URL as fallback
            try {
              const directUrl = `${blob.url.split('/upload-groups')[0]}/upload-groups/${groupId}/metadata.json`;
              const fallbackMetadata = await fetchBlobJson<UploadGroupMetadata>(directUrl);
              
              if (fallbackMetadata && fallbackMetadata.id) {
                groups.push(fallbackMetadata);
                console.log(`[UploadGroups] Successfully loaded metadata via fallback for ${groupId}`);
                return;
              }
            } catch (fallbackError) {
              console.error(`[UploadGroups] Fallback fetch also failed for ${groupId}:`, fallbackError);
            }
            
            // If all else fails, create placeholder
            groups.push({
              id: groupId,
              uploadDate: blob.uploadedAt?.toISOString() || new Date().toISOString(),
              files: [{
                name: isDevelopment 
                  ? 'Blob access restricted in development' 
                  : 'Unable to load metadata',
                url: blob.url,
                size: blob.size || 0,
                type: 'metadata',
              }],
              totalSize: blob.size || 0,
              geminiProcessing: {
                status: 'error' as const,
                error: 'Failed to load blob metadata - possible access permission issue'
              }
            });
            console.log(`[UploadGroups] Created error placeholder entry for ${groupId}`);
          }
          // Continue with other files even if one fails
        }
      });
    }

    // Sort by upload date (newest first)
    groups.sort((a, b) =>
      new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime()
    );

    // Archived groups leave the working list but are never deleted. `?archived=1`
    // serves the Archived view; both counts ship so the nav can label itself.
    const wantArchived = new URL(request.url).searchParams.get('archived') === '1';
    const archivedCount = groups.filter((g) => !!g.archived).length;
    const visible = groups.filter((g) => (wantArchived ? !!g.archived : !g.archived));

    // Any workflow run still in progress, so the card can link to it.
    const runs = await activeRunsFor(visible.map((g) => g.id)).catch((e: unknown) => {
      console.error('[UploadGroups] workflow run lookup failed (non-fatal):', e);
      return {} as Record<string, ActiveRun>;
    });
    for (const g of visible) {
      if (runs[g.id]) g.workflowRun = runs[g.id];
    }

    return NextResponse.json({
      success: true,
      groups: visible.map(toListItem),
      count: visible.length,
      activeCount: groups.length - archivedCount,
      archivedCount,
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      }
    });
  } catch (error) {
    console.error('Error fetching upload groups:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch upload groups', 
        details: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}