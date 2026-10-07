/**
 * Upload Strategy Utility
 * 
 * Determines whether to use direct blob storage upload (production)
 * or traditional server-side upload (development)
 */

export type UploadStrategy = 'direct' | 'server';

export function getUploadStrategy(): UploadStrategy {
  // Use direct upload in production to bypass Vercel's 4MB limit
  // Use server upload in development for easier debugging
  if (process.env.NODE_ENV === 'production') {
    return 'direct';
  }
  
  // Allow override via environment variable for testing
  if (process.env.FORCE_DIRECT_UPLOAD === 'true') {
    return 'direct';
  }
  
  return 'server';
}

export function shouldUseDirectUpload(): boolean {
  return getUploadStrategy() === 'direct';
}

// Client-side version (since process.env is not available in browser)
export function getClientUploadStrategy(): UploadStrategy {
  // Check if we're in production via window.location or other client-side indicators
  if (typeof window !== 'undefined') {
    const isProduction = 
      window.location.hostname !== 'localhost' && 
      window.location.hostname !== '127.0.0.1' &&
      !window.location.hostname.includes('.local');
    
    return isProduction ? 'direct' : 'server';
  }
  
  // Default to server for SSR
  return 'server';
}

export interface DirectUploadConfig {
  maxFileSize: number;
  allowedTypes: string[];
  uploadPath: string;
}

export const DIRECT_UPLOAD_CONFIG: DirectUploadConfig = {
  maxFileSize: 50 * 1024 * 1024, // 50MB max for direct uploads
  allowedTypes: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  uploadPath: 'upload-groups'
};