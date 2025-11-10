
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import JSZip from 'jszip';
import { UploadedFile, ProcessedImage, LoadingState, ActiveTool } from './types';
import {
  preprocessImage,
  enhanceForOcr,
  performOcr,
  analyzeImage,
  editImage,
  generateImage,
} from './services/geminiService';

// Helper to convert data URL to Blob for saving
async function dataURLtoBlob(dataUrl: string): Promise<Blob> {
    const response = await fetch(dataUrl);
    return await response.blob();
}

// Helper to read a File object into a Base64 data URL
const fileToDataUrl = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => {
            if (typeof e.target?.result === 'string') {
                resolve(e.target.result);
            } else {
                reject(new Error('Failed to read file as data URL.'));
            }
        };
        reader.onerror = error => reject(error);
        reader.readAsDataURL(file);
    });
};

// Efficiently and synchronously calculate size from a data URL.
function getBase64Size(dataUrl: string): number {
    const base64Index = dataUrl.indexOf(',');
    if (base64Index === -1) return 0;
    
    const base64 = dataUrl.substring(base64Index + 1);
    
    let padding = 0;
    if (base64.endsWith('==')) {
        padding = 2;
    } else if (base64.endsWith('=')) {
        padding = 1;
    }
    
    return (base64.length * 3 / 4) - padding;
}

// Optimized and memoized component for displaying images.
const ImageWithHistory: React.FC<{ file: UploadedFile | undefined }> = React.memo(({ file }) => {
    if (!file) return null;

    const originalDisplayUrl = file.thumbnailUrl;
    const originalDescription = 'Original';
    const originalSize = file.file.size;
    const currentProcessed = file.history.length > 0 ? file.history[file.history.length - 1] : null;

    return (
        <div style={styles.imageComparison}>
            <div style={styles.imageDisplay}>
                <h4>{originalDescription}</h4>
                <img src={originalDisplayUrl} alt={originalDescription} style={{maxWidth: '100%', borderRadius: '4px'}}/>
                <p>Size: {(originalSize / 1024).toFixed(2)} KB</p>
            </div>
            {currentProcessed && currentProcessed.dataUrl && (
                <div style={styles.imageDisplay}>
                    <h4>{currentProcessed.description}</h4>
                    <img src={currentProcessed.dataUrl} alt={currentProcessed.description} style={{maxWidth: '100%', borderRadius: '4px'}}/>
                    <p>Size: {currentProcessed.size > 0 ? `${(currentProcessed.size / 1024).toFixed(2)} KB` : 'N/A'}</p>
                </div>
            )}
        </div>
    );
});


const App: React.FC = () => {
    const [activeTool, setActiveTool] = useState<ActiveTool>(ActiveTool.Processor);
    const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
    const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
    const [batchSelectedIds, setBatchSelectedIds] = useState<Set<string>>(new Set());
    const [loadingState, setLoadingState] = useState<LoadingState>({ active: false, message: '' });
    const [prompts, setPrompts] = useState<{ [key in ActiveTool]?: string }>({});
    const [ocrResults, setOcrResults] = useState<Record<string, { name: string, text: string }>>({});
    const [analysisResult, setAnalysisResult] = useState<string>('');
    const [downloadFolderName, setDownloadFolderName] = useState<string | null>(null);
    const [canUseDirectoryPicker, setCanUseDirectoryPicker] = useState(false);

    const uploadedFilesRef = useRef(uploadedFiles);
    useEffect(() => {
        uploadedFilesRef.current = uploadedFiles;
    }, [uploadedFiles]);

    const directoryHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
    
    // Effect to manage Object URL cleanup
    useEffect(() => {
        return () => {
            // On component unmount, revoke all existing thumbnail URLs
            uploadedFilesRef.current.forEach(file => {
                URL.revokeObjectURL(file.thumbnailUrl);
            });
        };
    }, []);

    useEffect(() => {
        const isSupported = 'showDirectoryPicker' in window;
        const isTopLevel = window.self === window.top;
        setCanUseDirectoryPicker(isSupported && isTopLevel);
    }, []);
    
    useEffect(() => {
        if (!selectedFileId && uploadedFiles.length > 0) {
            setSelectedFileId(uploadedFiles[0].id);
        }
        if (selectedFileId && !uploadedFiles.some(f => f.id === selectedFileId)) {
            setSelectedFileId(uploadedFiles.length > 0 ? uploadedFiles[0].id : null);
        }
    }, [uploadedFiles, selectedFileId]);

    useEffect(() => {
        setAnalysisResult('');
    }, [selectedFileId]);

    const selectedFile = useMemo(() => uploadedFiles.find(f => f.id === selectedFileId), [uploadedFiles, selectedFileId]);

    // Derived state for the currently displayed image (original or last processed)
    const currentImageForDisplay = useMemo(() => {
        if (!selectedFile) return undefined;
        if (selectedFile.history.length > 0) {
            return selectedFile.history[selectedFile.history.length - 1];
        }
        // If no history, represent the original file for display purposes
        return {
            dataUrl: selectedFile.thumbnailUrl, // Use object URL for display
            size: selectedFile.file.size,
            description: 'Original',
        };
    }, [selectedFile]);

    // NEW: Creates a file object without reading the full file into memory.
    const createUploadedFile = (file: File): Promise<UploadedFile> => {
        return new Promise((resolve, reject) => {
            if (!file.type.startsWith('image/')) {
                return reject(new Error(`File is not a valid image: ${file.name}`));
            }
            const thumbnailUrl = URL.createObjectURL(file);
            const newFile: UploadedFile = {
                id: `${file.name}-${Date.now()}`,
                file,
                thumbnailUrl,
                history: [], // History starts empty, original is not stored here
            };
            resolve(newFile);
        });
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            setLoadingState({ active: true, message: 'Uploading files...' });
            const files = Array.from(e.target.files);
            const results = await Promise.allSettled(files.map(createUploadedFile));

            const newFiles: UploadedFile[] = [];
            const failedFiles: string[] = [];

            results.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    newFiles.push(result.value);
                } else {
                    console.error("File upload failed:", result.reason);
                    failedFiles.push(files[index].name);
                }
            });

            if (newFiles.length > 0) {
                setUploadedFiles(prev => [...prev, ...newFiles]);
            }
            
            if (failedFiles.length > 0) {
                alert(`Could not upload the following files:\n${failedFiles.join('\n')}`);
            }

            setLoadingState({ active: false, message: '' });
        }
    };
    
    const updateFileHistory = useCallback((fileId: string, dataUrl: string, description: string) => {
        const newHistoryEntry: ProcessedImage = {
            dataUrl,
            size: getBase64Size(dataUrl),
            description,
        };

        setUploadedFiles(currentFiles =>
            currentFiles.map(f => {
                if (f.id === fileId) {
                    const newHistory = [...f.history];
                    // Prune the dataUrl of the PREVIOUSLY last item to save memory
                    if (newHistory.length > 0) {
                        const lastIndex = newHistory.length - 1;
                        newHistory[lastIndex] = { ...newHistory[lastIndex], dataUrl: '' };
                    }
                    newHistory.push(newHistoryEntry);
                    return { ...f, history: newHistory };
                }
                return f;
            })
        );
    }, []);

    // Gets the data URL for the latest version of a file, lazy-loading from the File object if needed.
    const getLatestImageDataUrl = async (file: UploadedFile): Promise<string> => {
        if (file.history.length > 0) {
            const latest = file.history[file.history.length - 1];
            if (latest.dataUrl) {
                return latest.dataUrl;
            }
        }
        // If no history or last history is pruned, read from the original file.
        return fileToDataUrl(file.file);
    };

    const handleBatchAction = useCallback(async (
      processorFn: (dataUrl: string) => Promise<string>,
      description: string,
      targetFileIds: string[]
    ) => {
      if (targetFileIds.length === 0) return;

      setLoadingState({ active: true, message: `Starting batch ${description.toLowerCase()}...` });
      try {
        for (let i = 0; i < targetFileIds.length; i++) {
          const fileId = targetFileIds[i];
          const file = uploadedFilesRef.current.find(f => f.id === fileId);
          if (file) {
            setLoadingState({ active: true, message: `Processing ${i + 1}/${targetFileIds.length}: ${file.file.name}` });
            const currentImageDataUrl = await getLatestImageDataUrl(file);
            const processedDataUrl = await processorFn(currentImageDataUrl);
            updateFileHistory(fileId, processedDataUrl, description);
          }
        }
      } catch (error) {
          console.error(`${description} failed:`, error);
          alert(`Failed to ${description.toLowerCase()} one or more images.`);
      } finally {
          setLoadingState({ active: false, message: '' });
      }
    }, [updateFileHistory]);

    const handleBatchOcr = useCallback(async (targetFileIds: string[]) => {
      if (targetFileIds.length === 0) return;

      setLoadingState({ active: true, message: 'Starting batch OCR...' });
      try {
        for (let i = 0; i < targetFileIds.length; i++) {
          const fileId = targetFileIds[i];
          const file = uploadedFilesRef.current.find(f => f.id === fileId);
          if (file) {
            setLoadingState({ active: true, message: `Performing OCR ${i + 1}/${targetFileIds.length}: ${file.file.name}` });
            const currentImageDataUrl = await getLatestImageDataUrl(file);
            const text = await performOcr(currentImageDataUrl);
            setOcrResults(prev => ({ ...prev, [fileId]: { name: file.file.name, text } }));
          }
        }
      } catch (error) {
        console.error('OCR failed:', error);
        alert('Failed to perform OCR on one or more images.');
      } finally {
        setLoadingState({ active: false, message: '' });
      }
    }, []);

    const saveFile = useCallback(async (blob: Blob, fileName: string) => {
        const downloadWithAnchor = () => {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        };

        if (directoryHandleRef.current) {
            try {
                const fileHandle = await directoryHandleRef.current.getFileHandle(fileName, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
            } catch (error) {
                console.error('Error saving file directly, falling back to download prompt:', error);
                downloadWithAnchor();
            }
        } else {
            downloadWithAnchor();
        }
    }, []);

    const getFileNameParts = (fileName: string) => {
        const dotIndex = fileName.lastIndexOf('.');
        if (dotIndex === -1 || dotIndex === 0) {
            return { baseName: fileName, extension: '' };
        }
        return {
            baseName: fileName.substring(0, dotIndex),
            extension: fileName.substring(dotIndex),
        };
    };

    const handleAutoProcessBatch = useCallback(async (targetFileIds: string[]) => {
        if (targetFileIds.length === 0) return;
        setLoadingState({ active: true, message: 'Starting Auto-Process batch...' });
    
        try {
            for (let i = 0; i < targetFileIds.length; i++) {
                const fileId = targetFileIds[i];
                let file = uploadedFilesRef.current.find(f => f.id === fileId);
                if (!file) continue;
    
                let currentImageUrl = await getLatestImageDataUrl(file);
    
                setLoadingState({ active: true, message: `[${i + 1}/${targetFileIds.length}] Preprocessing: ${file.file.name}` });
                const preprocessedUrl = await preprocessImage(currentImageUrl);
                updateFileHistory(fileId, preprocessedUrl, 'Preprocessed');
                
                // Get the updated file state for the next step
                file = uploadedFilesRef.current.find(f => f.id === fileId)!;
                currentImageUrl = await getLatestImageDataUrl(file);

                setLoadingState({ active: true, message: `[${i + 1}/${targetFileIds.length}] Enhancing: ${file.file.name}` });
                const enhancedUrl = await enhanceForOcr(currentImageUrl);
                updateFileHistory(fileId, enhancedUrl, 'Enhanced for OCR');

                // We use enhancedUrl directly for OCR and saving
                setLoadingState({ active: true, message: `[${i + 1}/${targetFileIds.length}] Performing OCR: ${file.file.name}` });
                const text = await performOcr(enhancedUrl);
                setOcrResults(prev => ({ ...prev, [fileId]: { name: file.file.name, text } }));

                setLoadingState({ active: true, message: `[${i + 1}/${targetFileIds.length}] Saving results: ${file.file.name}` });
                
                const { baseName, extension } = getFileNameParts(file.file.name);
                
                const imageBlob = await dataURLtoBlob(enhancedUrl);
                const imageName = `${baseName}_Enhanced_for_OCR${extension}`;
                await saveFile(imageBlob, imageName);

                const textBlob = new Blob([text], { type: 'text/plain' });
                const textName = `${baseName}_OCR_TEXT.txt`;
                await saveFile(textBlob, textName);
            }
        } catch (error) {
            console.error('Auto-Process failed:', error);
            alert('The auto-process batch failed on one of the steps. Any completed files have been saved.');
        } finally {
            setLoadingState({ active: false, message: '' });
        }
    }, [updateFileHistory, saveFile]);

    const handleToggleBatchSelect = (fileId: string, checked: boolean) => {
        setBatchSelectedIds(prev => {
            const newSet = new Set(prev);
            if (checked) {
                newSet.add(fileId);
            } else {
                newSet.delete(fileId);
            }
            return newSet;
        });
    };
    
    const handleSelectAll = (checked: boolean) => {
        if (checked) {
            setBatchSelectedIds(new Set(uploadedFiles.map(f => f.id)));
        } else {
            setBatchSelectedIds(new Set());
        }
    };

    const handleDownloadFile = useCallback(async (fileId: string) => {
      const file = uploadedFilesRef.current.find(f => f.id === fileId);
      if (!file) return;

      if (file.history.length > 0) {
          const current = file.history[file.history.length - 1];
          if (current.dataUrl) {
              const blob = await dataURLtoBlob(current.dataUrl);
              const { baseName, extension } = getFileNameParts(file.file.name);
              const downloadName = `${baseName}_${current.description.replace(/\s+/g, '_')}${extension}`;
              await saveFile(blob, downloadName);
          } else {
               alert("The data for this image has been pruned to save memory and cannot be downloaded.");
          }
      } else {
          // History is empty, download the original file.
          await saveFile(file.file, file.file.name);
      }
    }, [saveFile]);

    const handleBatchDownload = useCallback(async () => {
        if (batchSelectedIds.size === 0) return;
    
        setLoadingState({ active: true, message: 'Creating ZIP file...' });
        try {
            const zip = new JSZip();
            const filesToZip = Array.from(batchSelectedIds)
                .map(id => uploadedFilesRef.current.find(f => f.id === id))
                .filter((f): f is UploadedFile => !!f);
    
            for (const file of filesToZip) {
                const { baseName, extension } = getFileNameParts(file.file.name);
                if (file.history.length > 0) {
                    const current = file.history[file.history.length - 1];
                    if (current.dataUrl) {
                        const blob = await dataURLtoBlob(current.dataUrl);
                        const downloadName = `${baseName}_${current.description.replace(/\s+/g, '_')}${extension}`;
                        zip.file(downloadName, blob);
                    }
                } else {
                    // No history, zip the original file
                    const downloadName = `${baseName}_Original${extension}`;
                    zip.file(downloadName, file.file);
                }
            }
    
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            await saveFile(zipBlob, 'processed_images.zip');
        } catch (error) {
            console.error("Failed to create ZIP file:", error);
            alert("There was an error creating the zip file for download.");
        } finally {
            setLoadingState({ active: false, message: '' });
        }
    }, [batchSelectedIds, saveFile]);

    const handleDownloadOcrText = useCallback(async () => {
        const idsWithOcr = [...batchSelectedIds].filter(id => ocrResults[id]);
        if (idsWithOcr.length === 0) return;
    
        setLoadingState({ active: true, message: 'Creating ZIP file with OCR text...' });
        try {
            const zip = new JSZip();
            for (const fileId of idsWithOcr) {
                const result = ocrResults[fileId];
                if (result) {
                    const blob = new Blob([result.text], { type: 'text/plain' });
                    const { baseName } = getFileNameParts(result.name);
                    const fileName = `${baseName}_OCR_TEXT.txt`;
                    zip.file(fileName, blob);
                }
            }
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            await saveFile(zipBlob, 'ocr_results.zip');
        } catch (error) {
            console.error("Failed to create ZIP file for OCR text:", error);
            alert("There was an error creating the zip file for OCR text.");
        } finally {
            setLoadingState({ active: false, message: '' });
        }
    }, [batchSelectedIds, ocrResults, saveFile]);

    const handleSelectDownloadFolder = async () => {
        if (!canUseDirectoryPicker) {
            alert('This feature is not available in the current sandboxed environment.');
            return;
        }
        try {
            const handle = await (window as any).showDirectoryPicker();
            if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
                if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
                    alert('Permission to write to the selected folder was denied.');
                    directoryHandleRef.current = null;
                    setDownloadFolderName(null);
                    return;
                }
            }
            directoryHandleRef.current = handle;
            setDownloadFolderName(handle.name);
        } catch (error) {
            // FIX: Add type guard before accessing `error.name` to prevent runtime errors.
            if (error instanceof Error && error.name === 'AbortError') {
                console.log('Directory picker cancelled by user.');
            } else {
                console.error('Error selecting directory:', error);
                const message = error instanceof Error ? error.message : String(error);
                alert(`Could not open directory picker. Error: ${message}. This feature may be blocked in sandboxed environments.`);
            }
        }
    };

    const handleEditImage = useCallback(async () => {
        const prompt = prompts[ActiveTool.Editor];
        if (!selectedFileId || !prompt) return;

        const file = uploadedFilesRef.current.find(f => f.id === selectedFileId);
        if (!file) return;

        setLoadingState({ active: true, message: 'Editing image...' });
        try {
            const imageUrlToEdit = await getLatestImageDataUrl(file);
            const editedDataUrl = await editImage(imageUrlToEdit, prompt);
            updateFileHistory(selectedFileId, editedDataUrl, `Edited: ${prompt.substring(0, 30)}...`);
        } catch (error) {
            console.error('Editing failed:', error);
            alert('Failed to edit image.');
        } finally {
            setLoadingState({ active: false, message: '' });
        }
    }, [prompts, selectedFileId, updateFileHistory]);

    const handleGenerateImage = useCallback(async () => {
        const prompt = prompts[ActiveTool.Generator];
        if (!prompt) return;
        setLoadingState({ active: true, message: 'Generating image...' });
        try {
            const generatedDataUrl = await generateImage(prompt);
            const blob = await dataURLtoBlob(generatedDataUrl);
            const safePrompt = prompt.replace(/[\\/:"*?<>|]/g, '-').slice(0, 20);
            const file = new File([blob], `${safePrompt}.jpg`, { type: blob.type });
            
            // Use the new memory-safe creation function
            const newFile = await createUploadedFile(file);
            
            // Manually add a history entry for the generated image
            const generatedHistoryEntry: ProcessedImage = {
                dataUrl: generatedDataUrl,
                size: getBase64Size(generatedDataUrl),
                description: `Generated: ${prompt.substring(0, 30)}...`,
            };
            newFile.history.push(generatedHistoryEntry);
            
            setUploadedFiles(prev => [...prev, newFile]);
            setSelectedFileId(newFile.id);
        } catch (error) {
            console.error('Generation failed:', error);
            alert('Failed to generate image.');
        } finally {
            setLoadingState({ active: false, message: '' });
        }
    }, [prompts]);

    const handleAnalyzeImage = useCallback(async () => {
        const prompt = prompts[ActiveTool.Analyzer];
        if (!selectedFileId || !prompt) return;
        
        const file = uploadedFilesRef.current.find(f => f.id === selectedFileId);
        if (!file) return;

        setLoadingState({ active: true, message: 'Analyzing image...' });
        setAnalysisResult('');
        try {
            const imageUrlToAnalyze = await getLatestImageDataUrl(file);
            const result = await analyzeImage(imageUrlToAnalyze, prompt);
            setAnalysisResult(result);
        } catch (error) {
            console.error('Analysis failed:', error);
            alert('Failed to analyze image.');
        } finally {
            setLoadingState({ active: false, message: '' });
        }
    }, [prompts, selectedFileId]);

    const renderToolUI = () => {
      const isImageSelected = !!selectedFile;

      const noImagePlaceholder = (message: string) => (
        <div style={styles.placeholder}>{message}</div>
      );
  
      switch(activeTool) {
        case ActiveTool.Processor:
            if (!isImageSelected) return noImagePlaceholder('Upload and select an image to use the Processor.');
            return (
                <div style={styles.imageViewer}>
                    <ImageWithHistory file={selectedFile} />
                    <div style={styles.toolControls}>
                        <h3>Processor</h3>
                        <p>Actions for: <b>{selectedFile?.file.name}</b></p>
                        <button style={styles.button} onClick={() => handleBatchAction(preprocessImage, 'Preprocessed', [selectedFileId!])} disabled={loadingState.active}>Preprocess (De-skew & Crop)</button>
                        <button style={styles.button} onClick={() => handleBatchAction(enhanceForOcr, 'Enhanced for OCR', [selectedFileId!])} disabled={loadingState.active}>Enhance for OCR</button>
                        <button style={styles.button} onClick={() => handleBatchOcr([selectedFileId!])} disabled={loadingState.active}>Perform OCR</button>
                        <button style={{...styles.button, backgroundColor: '#1a73e8'}} onClick={() => handleDownloadFile(selectedFileId!)} disabled={loadingState.active}>Download Current Image</button>

                        {selectedFileId && ocrResults[selectedFileId] && (
                            <div style={styles.ocrResult}>
                                <h4>OCR Result:</h4>
                                <pre style={styles.preformattedText}>{ocrResults[selectedFileId].text}</pre>
                            </div>
                        )}
                    </div>
                </div>
            );
        case ActiveTool.Editor:
            if (!isImageSelected) return noImagePlaceholder('Upload and select an image to use the Editor.');
            return (
                <div style={styles.imageViewer}>
                    <ImageWithHistory file={selectedFile} />
                    <div style={styles.toolControls}>
                        <h3>Editor</h3>
                        <textarea
                            value={prompts[ActiveTool.Editor] || ''}
                            onChange={(e) => setPrompts(p => ({...p, [ActiveTool.Editor]: e.target.value}))}
                            placeholder="e.g., 'add a hat on the person'"
                            style={styles.promptInput}
                        />
                        <button style={styles.button} onClick={handleEditImage} disabled={loadingState.active || !prompts[ActiveTool.Editor]}>Apply Edit</button>
                    </div>
                </div>
            );
        case ActiveTool.Generator:
            return (
                <div style={{...styles.imageViewer, flexDirection: 'column'}}>
                    <div style={{...styles.toolControls, width: '100%'}}>
                        <h3>Generator</h3>
                        <textarea
                            value={prompts[ActiveTool.Generator] || ''}
                            onChange={(e) => setPrompts(p => ({...p, [ActiveTool.Generator]: e.target.value}))}
                            placeholder="e.g., 'a cat wearing a spacesuit on Mars, cinematic lighting'"
                            style={styles.promptInput}
                        />
                        <button style={styles.button} onClick={handleGenerateImage} disabled={loadingState.active || !prompts[ActiveTool.Generator]}>Generate Image</button>
                    </div>
                    {isImageSelected && selectedFile?.history[0]?.description.startsWith('Generated:') ? (
                        <div style={{ marginTop: '20px' }}>
                            <ImageWithHistory file={selectedFile} />
                        </div>
                    ) : (
                      !isImageSelected && <div style={styles.placeholder}>Enter a prompt to generate an image.</div>
                    )
                    }
                </div>
            );
        case ActiveTool.Analyzer:
            if (!isImageSelected) return noImagePlaceholder('Upload and select an image to use the Analyzer.');
            return (
                <div style={styles.imageViewer}>
                    <ImageWithHistory file={selectedFile} />
                    <div style={styles.toolControls}>
                        <h3>Analyzer</h3>
                        <textarea
                            value={prompts[ActiveTool.Analyzer] || ''}
                            onChange={(e) => setPrompts(p => ({...p, [ActiveTool.Analyzer]: e.target.value}))}
                            placeholder="e.g., 'describe this image in detail'"
                            style={styles.promptInput}
                        />
                        <button style={styles.button} onClick={handleAnalyzeImage} disabled={loadingState.active || !prompts[ActiveTool.Analyzer]}>Analyze</button>
                        {analysisResult && (
                            <div style={styles.ocrResult}>
                                <h4>Analysis Result:</h4>
                                <pre style={styles.preformattedText}>{analysisResult}</pre>
                            </div>
                        )}
                    </div>
                </div>
            );
        default:
            return null;
      }
    };
    
    const allFilesSelected = uploadedFiles.length > 0 && batchSelectedIds.size === uploadedFiles.length;

    const hasOcrForSelected = [...batchSelectedIds].some(id => ocrResults[id]);

    const selectFolderBtnStyle = {
      ...styles.batchButton,
      ...(!canUseDirectoryPicker ? styles.buttonDisabled : {})
    };

    const selectFolderBtnTitle = canUseDirectoryPicker
      ? 'Select a folder for direct downloads'
      : 'This feature is unavailable in sandboxed environments (like iframes).';

    return (
        <div style={styles.app}>
            {loadingState.active && (
                <div style={styles.loaderOverlay}>
                    <div style={styles.loaderContent}>{loadingState.message}</div>
                </div>
            )}
            <header style={styles.header}>
                <h1>Gemini Image Studio</h1>
                <nav style={styles.nav}>
                    {Object.values(ActiveTool).map(tool => (
                        <button
                            key={tool}
                            style={activeTool === tool ? {...styles.navButton, ...styles.navButtonActive} : styles.navButton}
                            onClick={() => setActiveTool(tool)}
                        >
                            {tool}
                        </button>
                    ))}
                </nav>
            </header>
            <main style={styles.main}>
                <aside style={styles.sidebar}>
                  <div style={styles.uploadSection}>
                      <label htmlFor="file-upload" style={styles.uploadLabel}>
                          Upload Images
                      </label>
                      <input id="file-upload" type="file" multiple accept="image/*" onChange={handleFileChange} style={{ display: 'none' }} />
                  </div>

                  <div style={styles.downloadSettings}>
                    <h4>Download Settings</h4>
                    <button 
                      style={selectFolderBtnStyle} 
                      onClick={handleSelectDownloadFolder}
                      title={selectFolderBtnTitle}
                      disabled={!canUseDirectoryPicker}
                    >
                      Select Download Folder
                    </button>
                    <p style={styles.folderName}>Folder: <span>{downloadFolderName || 'Not set'}</span></p>
                  </div>

                  {batchSelectedIds.size > 0 && (
                    <div style={styles.batchActions}>
                        <h4>Batch Actions ({batchSelectedIds.size} selected)</h4>
                        <button style={{...styles.batchButton, backgroundColor: '#c53929', color: 'white', fontWeight: 'bold' }} onClick={() => handleAutoProcessBatch(Array.from(batchSelectedIds))} disabled={loadingState.active}>Auto-Process & Save Batch</button>
                        <button style={styles.batchButton} onClick={() => handleBatchAction(preprocessImage, 'Preprocessed', Array.from(batchSelectedIds))} disabled={loadingState.active}>Preprocess</button>
                        <button style={styles.batchButton} onClick={() => handleBatchAction(enhanceForOcr, 'Enhanced for OCR', Array.from(batchSelectedIds))} disabled={loadingState.active}>Enhance</button>
                        <button style={styles.batchButton} onClick={() => handleBatchOcr(Array.from(batchSelectedIds))} disabled={loadingState.active}>OCR</button>
                        <button style={{...styles.batchButton, backgroundColor: '#1a73e8'}} onClick={handleBatchDownload} disabled={loadingState.active}>Download Images (ZIP)</button>
                        {hasOcrForSelected && <button style={{...styles.batchButton, backgroundColor: '#0d652d'}} onClick={handleDownloadOcrText} disabled={loadingState.active}>Download OCR Text (ZIP)</button>}
                    </div>
                  )}

                  <div style={styles.fileListHeader}>
                    <input type="checkbox" checked={allFilesSelected} onChange={(e) => handleSelectAll(e.target.checked)} disabled={uploadedFiles.length === 0} />
                    <label>Select All</label>
                  </div>
                  <div style={styles.fileList}>
                      {uploadedFiles.map(file => (
                          <div
                              key={file.id}
                              style={file.id === selectedFileId ? {...styles.fileListItem, ...styles.fileListItemSelected} : styles.fileListItem}
                              onClick={() => setSelectedFileId(file.id)}
                          >
                              <input 
                                type="checkbox" 
                                style={{marginRight: '12px', flexShrink: 0}} 
                                checked={batchSelectedIds.has(file.id)}
                                onChange={(e) => {
                                    e.stopPropagation();
                                    handleToggleBatchSelect(file.id, e.target.checked)
                                }}
                              />
                              <img src={file.thumbnailUrl} alt="thumbnail" style={styles.thumbnail} />
                              <span style={styles.fileName}>{file.file.name}</span>
                          </div>
                      ))}
                  </div>
                </aside>
                <section style={styles.content}>
                    {renderToolUI()}
                </section>
            </main>
        </div>
    );
};

const styles: { [key: string]: React.CSSProperties } = {
    app: {
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      backgroundColor: '#1e1e1e',
      color: '#e0e0e0',
    },
    header: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '1rem 2rem',
      borderBottom: '1px solid #333',
      backgroundColor: '#252526',
    },
    nav: {
      display: 'flex',
      gap: '1rem',
    },
    navButton: {
      padding: '0.5rem 1rem',
      cursor: 'pointer',
      border: '1px solid #555',
      backgroundColor: 'transparent',
      color: '#ccc',
      borderRadius: '4px',
      fontSize: '14px',
    },
    navButtonActive: {
      backgroundColor: '#0e639c',
      color: 'white',
      borderColor: '#0e639c',
    },
    main: {
      display: 'flex',
      flex: 1,
      overflow: 'hidden',
    },
    sidebar: {
      width: '320px',
      borderRight: '1px solid #333',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#252526',
    },
    uploadSection: {
      padding: '1rem',
      borderBottom: '1px solid #333',
    },
    uploadLabel: {
      display: 'block',
      padding: '0.75rem',
      backgroundColor: '#0e639c',
      color: 'white',
      textAlign: 'center',
      borderRadius: '4px',
      cursor: 'pointer',
      fontWeight: 'bold',
    },
    downloadSettings: {
        padding: '1rem',
        borderBottom: '1px solid #333',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
    },
    folderName: {
        margin: '0.5rem 0 0',
        fontSize: '12px',
        color: '#aaa',
    },
    batchActions: {
      padding: '1rem',
      borderBottom: '1px solid #333',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.5rem',
      backgroundColor: '#37373d',
    },
    batchButton: {
      padding: '0.5rem',
      backgroundColor: '#4a4a4a',
      color: 'white',
      border: '1px solid #555',
      borderRadius: '4px',
      cursor: 'pointer',
      fontSize: '13px',
      textAlign: 'center',
    },
    buttonDisabled: {
        backgroundColor: '#3a3a3a',
        color: '#888',
        cursor: 'not-allowed',
        border: '1px solid #444',
    },
    fileListHeader: {
      display: 'flex',
      alignItems: 'center',
      padding: '0.5rem 1rem',
      borderBottom: '1px solid #333',
      fontSize: '14px',
      gap: '0.5rem',
      color: '#ccc'
    },
    fileList: {
      flex: 1,
      overflowY: 'auto',
    },
    fileListItem: {
      display: 'flex',
      alignItems: 'center',
      padding: '0.75rem 1rem',
      cursor: 'pointer',
      borderBottom: '1px solid #333',
    },
    fileListItemSelected: {
      backgroundColor: '#37373d',
    },
    thumbnail: {
      width: '40px',
      height: '40px',
      objectFit: 'cover',
      marginRight: '12px',
      borderRadius: '4px',
      border: '1px solid #444',
    },
    fileName: {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      fontSize: '14px',
    },
    content: {
      flex: 1,
      padding: '2rem',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
    },
    placeholder: {
      flex: 1,
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      color: '#888',
      fontSize: '1.2rem',
      textAlign: 'center',
    },
    imageViewer: {
      display: 'flex',
      gap: '2rem',
      width: '100%',
    },
    imageComparison: {
      display: 'flex',
      gap: '1rem',
      flex: 3,
    },
    imageDisplay: {
      flex: 1,
      textAlign: 'center',
      backgroundColor: '#2a2d2e',
      padding: '1rem',
      borderRadius: '8px',
    },
    toolControls: {
      flex: 2,
      display: 'flex',
      flexDirection: 'column',
      gap: '1rem',
    },
    promptInput: {
      width: '100%',
      minHeight: '100px',
      padding: '0.75rem',
      backgroundColor: '#2a2d2e',
      border: '1px solid #555',
      color: '#e0e0e0',
      borderRadius: '4px',
      resize: 'vertical',
      fontSize: '14px',
    },
    button: {
      padding: '0.75rem',
      backgroundColor: '#0e639c',
      color: 'white',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
      fontSize: '14px',
      fontWeight: 'bold',
    },
    ocrResult: {
      marginTop: '1rem',
      padding: '1rem',
      backgroundColor: '#2a2d2e',
      borderRadius: '4px',
      maxHeight: '300px',
      overflowY: 'auto',
    },
    preformattedText: {
      whiteSpace: 'pre-wrap',
      wordWrap: 'break-word',
      color: '#d4d4d4',
      fontFamily: 'monospace',
    },
    loaderOverlay: {
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 1000,
    },
    loaderContent: {
      color: 'white',
      fontSize: '1.5rem',
      padding: '2rem',
      backgroundColor: '#252526',
      borderRadius: '8px',
    },
};

export default App;
