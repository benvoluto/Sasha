import { atom } from 'jotai';

// Type definitions
export interface UploadGroup {
  id: string;
  uploadDate: string;
  files: Array<{
    name: string;
    url: string;
    size: number;
    type: string;
  }>;
  totalSize: number;
  userId?: string;
  userEmail?: string;
  geminiProcessing?: {
    status: 'processing' | 'completed' | 'error' | 'partial';
    extractedContent?: string;
    processedAt?: string;
    error?: string;
    fileCount?: number;
  };
  /** The document's workflow run, while one is in progress. */
  workflowRun?: { id: string; status: 'running' | 'awaiting_review' | 'paused' };
  /** Set when the document has been archived out of the working list. */
  archived?: { at: string; by?: string };
  /** The person's own summary, shown on the sticky note in place of the generated one. */
  summaryNote?: { text: string; editedAt: string; editedBy?: string; basedOn?: string };
  /** The workflow chosen at upload to run once the documents are read (null: none). */
  autoWorkflow?: { workflowId: string | null; requestedBy: string } | null;
}

// Atoms for upload groups management
export const uploadGroupsAtom = atom<UploadGroup[]>([]);
export const uploadGroupsLoadingAtom = atom<boolean>(false);
export const uploadGroupsErrorAtom = atom<string | null>(null);
export const uploadGroupsRefreshTriggerAtom = atom<number>(0);
export const isInitialLoadAtom = atom<boolean>(true);

// Derived atom to check if any groups are processing
export const hasProcessingGroupsAtom = atom((get) => {
  const groups = get(uploadGroupsAtom);
  // A running workflow keeps the list polling too, so its link clears when the run ends.
  return groups.some(group =>
    group.geminiProcessing?.status === 'processing' || group.workflowRun?.status === 'running'
  );
});

// Atom for tracking the last fetch time (for cache invalidation)
export const lastFetchTimeAtom = atom<number>(0);

// Atom for expanded sections (per group)
export const expandedSectionAtom = atom<{ 
  groupId: string | null; 
  section: 'documents' | 'details' | null 
}>({ 
  groupId: null, 
  section: null 
});

// Action atoms for operations
export const fetchUploadGroupsAtom = atom(
  null,
  async (get, set) => {
    // Use the enhanced fetch with default behavior (don't skip loading state)
    return await set(fetchUploadGroupsAtomWithOptions, { skipLoadingState: false });
  }
);

// Enhanced fetch atom that can skip loading state for background updates
export const fetchUploadGroupsAtomWithOptions = atom(
  null,
  async (get, set, options?: { skipLoadingState?: boolean }) => {
    const isInitialLoad = get(isInitialLoadAtom);
    const { skipLoadingState = false } = options || {};
    
    // Only show loading state for true initial load
    const shouldShowLoading = isInitialLoad && !skipLoadingState;
    
    if (shouldShowLoading) {
      set(uploadGroupsLoadingAtom, true);
      set(uploadGroupsErrorAtom, null);
    }
    
    try {
      const response = await fetch('/api/upload-groups', {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch upload groups: ${response.status}`);
      }

      const data = await response.json();
      set(uploadGroupsAtom, data.groups || []);
      
      // Mark initial load as complete after first successful fetch
      if (isInitialLoad) {
        set(isInitialLoadAtom, false);
      }
      
      // const logMessage = skipLoadingState || !isInitialLoad
      //   ? `[Jotai] Background update: ${data.groups?.length || 0} upload groups`
      //   : `[Jotai] Initial load: ${data.groups?.length || 0} upload groups`;
      // console.log(logMessage);
      
      return data.groups || [];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to load upload groups';
      
      if (shouldShowLoading) {
        set(uploadGroupsErrorAtom, errorMessage);
        console.error('[Jotai] Error fetching upload groups:', error);
      } else {
        console.warn('[Jotai] Background update error:', error);
      }
      
      return [];
    } finally {
      if (shouldShowLoading) {
        set(uploadGroupsLoadingAtom, false);
      }
    }
  }
);

export const refreshUploadGroupsAtom = atom(
  null,
  async (get, set) => {
    // Increment refresh trigger
    set(uploadGroupsRefreshTriggerAtom, get(uploadGroupsRefreshTriggerAtom) + 1);
    
    // Always skip loading state for refreshes (never show skeleton after initial load)
    return await set(fetchUploadGroupsAtomWithOptions, { skipLoadingState: true });
  }
);

// Documents the user just archived, hidden from the active list immediately so
// archiving feels instant. The list still refetches on mount and the archived
// flag isn't visible on the eventually-consistent metadata blob for a beat, so a
// plain atom filter would flap the document back; this set survives the refetch. It
// is cleared on reload, and pruned once the server stops returning the document in
// the active list. A failed archive removes the id so the document reappears.
export const optimisticallyArchivedAtom = atom<string[]>([]);

/**
 * Optimistic archive: hide the document immediately, then PATCH in the background.
 * The caller can navigate away right away — on failure this rolls the document back
 * into the list. Never throws.
 */
export const archiveUploadGroupAtom = atom(
  null,
  async (get, set, groupId: string): Promise<boolean> => {
    const before = get(optimisticallyArchivedAtom);
    if (!before.includes(groupId)) set(optimisticallyArchivedAtom, [...before, groupId]);
    try {
      const response = await fetch(`/api/upload-groups/${groupId}/flags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      });
      if (!response.ok) throw new Error(`Failed to archive: ${response.status}`);
      // Reload quietly so the list, and the nav's active/archived counts, catch up.
      void set(fetchUploadGroupsAtomWithOptions, { skipLoadingState: true });
      return true;
    } catch (error) {
      console.error('[Jotai] Error archiving upload group:', error);
      set(optimisticallyArchivedAtom, get(optimisticallyArchivedAtom).filter((id) => id !== groupId));
      return false;
    }
  }
);

// Atom for polling when groups are processing
export const startPollingAtom = atom(
  null,
  (get, set) => {
    const intervalId = setInterval(async () => {
      const hasProcessing = get(hasProcessingGroupsAtom);
      if (hasProcessing) {
        console.log('[Jotai] Polling for processing updates...');
        await set(fetchUploadGroupsAtomWithOptions, { skipLoadingState: true });
      } else {
        clearInterval(intervalId);
      }
    }, 3000); // Poll every 3 seconds
    
    return intervalId;
  }
);