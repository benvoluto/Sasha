'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { File, Loader2, X, Plus, UploadCloud, Workflow } from "@/components/icons";
import { upload } from '@vercel/blob/client';
import { Typography } from '@/components/typography';
import { useSetAtom } from 'jotai';
import { refreshUploadGroupsAtom } from '@/lib/atoms';
import { getClientUploadStrategy } from '@/lib/upload-strategy';

interface FileWithPreview extends File {
  preview?: string;
}

interface FileDropzoneProps {
  onUpload?: (files: File[]) => void;
  maxFiles?: number;
}

export function FileDropzone({ onUpload, maxFiles = 10 }: FileDropzoneProps) {
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const refreshGroups = useSetAtom(refreshUploadGroupsAtom);
  // The workflow to run once the documents are read: the default unless the uploader picks another, or "none".
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [workflowId, setWorkflowId] = useState('');
  const [defaultWorkflowId, setDefaultWorkflowId] = useState('');
  useEffect(() => {
    fetch('/api/workflows', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { workflows: Array<{ id: string; name: string }>; defaultWorkflowId: string } | null) => {
        if (!b) return;
        setWorkflows(b.workflows);
        setDefaultWorkflowId(b.defaultWorkflowId);
        setWorkflowId((current) => current || b.defaultWorkflowId);
      })
      .catch(() => {});
  }, []);

  const handleUpload = useCallback(async (filesToUpload?: File[]) => {
    const uploadFiles = filesToUpload || files;
    if (uploadFiles.length === 0) return;

    const uploadStrategy = getClientUploadStrategy();
    console.log('[FileDropzone] Upload strategy:', uploadStrategy);
    console.log('[FileDropzone] Starting upload of', uploadFiles.length, 'files');
    console.log('[FileDropzone] Files:', uploadFiles.map(f => ({ name: f.name, size: f.size })));
    
    setUploading(true);
    setUploadProgress(0);

    try {
      const chosen = workflowId || 'none';
      if (uploadStrategy === 'direct') {
        await handleDirectUpload(uploadFiles, chosen);
      } else {
        await handleServerUpload(uploadFiles, chosen);
      }
      
      setFiles([]);
      setUploadProgress(100);
      
      // Refresh the upload groups list using Jotai
      console.log('[FileDropzone] Triggering Jotai refresh of upload groups...');
      await refreshGroups();
      
      // Also notify parent component if callback provided
      if (onUpload) {
        console.log('[FileDropzone] Notifying parent component of upload completion...');
        onUpload(uploadFiles);
      }
      
      // Clear progress after a short delay
      setTimeout(() => {
        setUploadProgress(0);
      }, 2000);
    } catch (error) {
      console.error('[FileDropzone] Upload error:', error);
      console.error('[FileDropzone] Error details:', error instanceof Error ? error.stack : error);
      alert(`Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}. Please check console for details.`);
      // Keep files in the list so user can retry
    } finally {
      setUploading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, onUpload, refreshGroups, workflowId]);

  const handleServerUpload = useCallback(async (uploadFiles: File[], workflowId: string) => {
    console.log('[FileDropzone] Using server upload strategy');
    
    const formData = new FormData();
    uploadFiles.forEach((file, index) => {
      console.log('[FileDropzone] Adding file to FormData:', index, file.name, file.size, 'bytes');
      formData.append(`file_${index}`, file);
    });
    formData.append('fileCount', uploadFiles.length.toString());
    formData.append('workflowId', workflowId);
    console.log('[FileDropzone] FormData prepared with', uploadFiles.length, 'files');

    const startTime = Date.now();
    
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });
    
    const responseTime = Date.now() - startTime;
    console.log('[FileDropzone] Server response received in', responseTime, 'ms');
    console.log('[FileDropzone] Server response status:', response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[FileDropzone] Server upload failed with status:', response.status);
      console.error('[FileDropzone] Server error response:', errorText);
      throw new Error(`Server upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    console.log('[FileDropzone] Server upload API response:', result);
  }, []);

  const handleDirectUpload = useCallback(async (uploadFiles: File[], workflowId: string) => {
    console.log('[FileDropzone] Using direct upload strategy');
    
    // Step 1: Get presigned URLs
    console.log('[FileDropzone] Requesting presigned URLs...');
    const presignResponse = await fetch('/api/upload/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: uploadFiles.map(f => ({
          name: f.name,
          size: f.size,
          type: f.type
        }))
      })
    });

    if (!presignResponse.ok) {
      const errorText = await presignResponse.text();
      throw new Error(`Failed to get upload URLs: ${errorText}`);
    }

    const { groupId, uploads } = await presignResponse.json();
    console.log('[FileDropzone] Got presigned URLs for group:', groupId);

    // Step 2: Upload files directly to blob storage
    const uploadedFiles = [];
    for (let i = 0; i < uploadFiles.length; i++) {
      const file = uploadFiles[i];
      const uploadConfig = uploads[i];
      
      console.log(`[FileDropzone] Uploading file ${i + 1}/${uploadFiles.length}: ${file.name}`);
      
      try {
        const blob = await upload(uploadConfig.fields.blobPath, file, {
          access: 'public',
          handleUploadUrl: '/api/upload/direct',
          clientPayload: JSON.stringify(uploadConfig.fields)
        });

        console.log(`[FileDropzone] File ${i + 1} uploaded:`, blob.url);
        
        uploadedFiles.push({
          name: file.name,
          url: blob.url,
          size: file.size,
          type: file.type
        });

        // Update progress
        const progress = Math.round(((i + 1) / uploadFiles.length) * 80); // 80% for uploads
        setUploadProgress(progress);
        
      } catch (error) {
        console.error(`[FileDropzone] Failed to upload file ${file.name}:`, error);
        throw new Error(`Failed to upload file ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Step 3: Complete the upload process
    console.log('[FileDropzone] Completing upload process...');
    setUploadProgress(90);
    
    const completeResponse = await fetch('/api/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId,
        uploadedFiles,
        workflowId,
      })
    });

    if (!completeResponse.ok) {
      const errorText = await completeResponse.text();
      throw new Error(`Failed to complete upload: ${errorText}`);
    }

    const result = await completeResponse.json();
    console.log('[FileDropzone] Direct upload completed:', result);
  }, []);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const validFiles = acceptedFiles.filter(file => {
      const extension = file.name.split('.').pop()?.toLowerCase();
      return extension === 'pdf' || extension === 'docx';
    });
    if (validFiles.length === 0) return;
    // Stage the files; the user confirms with "Create Document with These Files"
    // before any processing starts.
    setFiles(prev => [...prev, ...validFiles]);
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
    },
    maxFiles,
    disabled: uploading,
    noClick: files.length > 0, // once staged, use the explicit buttons
  });


  // Empty state: the drop prompt. Once files are staged, show the confirm list.
  if (files.length === 0) {
    return (
      <div
        {...getRootProps()}
        className={`flex cursor-pointer flex-row items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center text-zinc-500 transition-all duration-200 dark:text-zinc-400 ${
          isDragActive
            ? 'border-teal-500 bg-teal-50 dark:bg-teal-950/20'
            : 'border-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-600'
        }`}
      >
        <input {...getInputProps()} />
        <UploadCloud className="h-7 w-7 text-zinc-400" />
        <Typography variant="paragraph-small">
          {isDragActive ? 'Drop the files here…' : 'Upload one or more source files to create a new document (PDF or DOCX)'}
        </Typography>
      </div>
    );
  }

  // Confirm step: list the staged files, allow removing / adding more, then
  // "Create Document with These Files" to start processing.
  return (
    <div
      {...getRootProps({ onClick: (e) => e.stopPropagation() })}
      className={`rounded-2xl border-2 border-dashed p-5 ${isDragActive ? 'border-teal-500 bg-teal-50 dark:bg-teal-950/20' : 'border-zinc-300 dark:border-zinc-700'}`}
    >
      <input {...getInputProps()} />
      <div className="flex flex-col gap-2">
        {files.map((file, index) => (
          <div
            key={`${file.name}-${index}`}
            className="flex items-center justify-between gap-3 rounded-xl bg-white px-4 py-3 dark:bg-zinc-900"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <File className="h-5 w-5 shrink-0 text-zinc-400" />
              <span className="truncate text-[15px] text-zinc-600 dark:text-zinc-300">{file.name}</span>
              <span className="shrink-0 text-xs text-zinc-400">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
            </div>
            <button
              type="button"
              onClick={() => removeFile(index)}
              disabled={uploading}
              className="flex shrink-0 items-center gap-1.5 text-[15px] font-medium text-teal-700 hover:text-red-600 disabled:opacity-50 dark:text-teal-400"
            >
              <X className="h-4 w-4" /> Remove
            </button>
          </div>
        ))}
      </div>

      {workflows.length > 0 && (
        <label className="mt-4 flex flex-wrap items-center gap-2 text-[15px] text-zinc-600 dark:text-zinc-300">
          <Workflow className="h-5 w-5 text-zinc-400" />
          Once the documents are read, run
          <select
            value={workflowId || 'none'}
            onChange={(e) => setWorkflowId(e.target.value === 'none' ? '' : e.target.value)}
            disabled={uploading}
            className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-[15px] font-medium text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            aria-label="Workflow to run"
          >
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.id === defaultWorkflowId ? ' (default)' : ''}
              </option>
            ))}
            <option value="none">No workflow</option>
          </select>
        </label>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <UploadCloud className="h-8 w-8 shrink-0 text-zinc-400" />
          <button
            type="button"
            onClick={open}
            disabled={uploading}
            className="inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white px-4 py-2.5 text-[15px] font-medium text-teal-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-teal-300"
          >
            <UploadCloud className="h-4 w-4" />
            Upload more source files for this document (PDF or DOCX)
          </button>
        </div>
        <button
          type="button"
          onClick={() => handleUpload(files)}
          disabled={uploading}
          className="inline-flex items-center gap-2 rounded-full bg-teal-800 px-5 py-2.5 text-[15px] font-medium text-white hover:bg-teal-900 disabled:opacity-60"
        >
          {uploading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {uploadProgress > 0 ? `Creating document… ${uploadProgress}%` : 'Creating document…'}
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" />
              Create Document with These Files
            </>
          )}
        </button>
      </div>
    </div>
  );
}