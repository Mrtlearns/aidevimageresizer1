export interface UploadedFile {
  id: string;
  file: File;
  thumbnailUrl: string; // Lightweight URL for thumbnails, from URL.createObjectURL()
  // History of transformations. Does not include the original image.
  // The last element is the current state with a dataUrl.
  // Previous elements have their dataUrl pruned to save memory.
  history: ProcessedImage[];
}

export interface ProcessedImage {
  dataUrl: string; // Can be an empty string for pruned history states
  size: number; // in bytes
  description: string; // e.g., "Preprocessed", "Grayscale"
}

export interface LoadingState {
  active: boolean;
  message: string;
}

export enum ActiveTool {
  Processor = 'Processor',
  Editor = 'Editor',
  Generator = 'Generator',
  Analyzer = 'Analyzer',
}
