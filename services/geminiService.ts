
import { GoogleGenAI, Modality, GenerateContentResponse } from "@google/genai";

const getApiKey = (): string => {
  const apiKey =
    import.meta.env.VITE_GEMINI_API_KEY ||
    import.meta.env.VITE_API_KEY ||
    '';

  if (!apiKey) {
    throw new Error(
      "Missing VITE_GEMINI_API_KEY (or VITE_API_KEY) environment variable. Set it in your .env file."
    );
  }

  return apiKey;
};

const getAiClient = () => {
  return new GoogleGenAI({ apiKey: getApiKey() });
};

type GeminiErrorPayload = {
  status?: string | number;
  message?: string;
  error?: {
    status?: string;
    message?: string;
    details?: Array<Record<string, unknown>>;
  };
};

const tryParseJson = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const extractGeminiErrorPayload = (error: unknown): GeminiErrorPayload | null => {
  if (!error) return null;

  if (typeof error === 'string') {
    const parsed = tryParseJson(error);
    return parsed ?? { message: error };
  }

  if (error instanceof Error) {
    const parsed = extractGeminiErrorPayload(error.message);
    if (parsed) {
      return parsed;
    }
    return { message: error.message };
  }

  if (typeof error === 'object') {
    return error as GeminiErrorPayload;
  }

  return null;
};

const extractQuotaDetail = (details?: Array<Record<string, unknown>>): string | undefined => {
  if (!details) return undefined;
  const quotaFailure = details.find(
    (detail) => typeof detail['@type'] === 'string' && (detail['@type'] as string).includes('QuotaFailure')
  );
  if (!quotaFailure) return undefined;
  const violations = (quotaFailure as Record<string, unknown>)['violations'];
  if (!Array.isArray(violations) || violations.length === 0) return undefined;

  const violation = violations[0] as Record<string, unknown>;
  return (
    (typeof violation.description === 'string' && violation.description) ||
    (typeof violation.quotaMetric === 'string' && `Quota metric exceeded: ${violation.quotaMetric}`) ||
    undefined
  );
};

const formatGeminiError = (error: unknown): string => {
  const payload = extractGeminiErrorPayload(error);
  const fallback = 'Gemini API request failed.';

  if (!payload) {
    return fallback;
  }

  const status = payload.error?.status ?? payload.status;
  const baseMessage = payload.error?.message ?? payload.message ?? fallback;
  const quotaMessage = extractQuotaDetail(payload.error?.details);
  const quotaHint =
    status === 'RESOURCE_EXHAUSTED'
      ? 'Your Gemini API key currently has no remaining quota for this model. Update your plan or use a key with access.'
      : undefined;

  return [baseMessage, quotaMessage, quotaHint].filter(Boolean).join(' ');
};

const withGeminiErrorHandling = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    throw new Error(formatGeminiError(error));
  }
};

const fileToGenerativePart = (fileDataUrl: string) => {
  const match = fileDataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) {
    console.error("Invalid data URL:", fileDataUrl.substring(0, 100) + "...");
    throw new Error('Invalid data URL format. Could not extract mime type and base64 data.');
  }
  const mimeType = match[1];
  const base64data = match[2];

  return {
    inlineData: {
      data: base64data,
      mimeType: mimeType,
    },
  };
};

const processImageWithPrompt = async (imageDataUrl: string, prompt: string): Promise<string> => {
    return withGeminiErrorHandling(async () => {
        const ai = getAiClient();
        const imagePart = fileToGenerativePart(imageDataUrl);
        const response: GenerateContentResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: [{
                parts: [
                    imagePart,
                    { text: prompt },
                ],
            }],
            config: {
                responseModalities: [Modality.IMAGE],
            },
        });
    
        const candidate = response.candidates?.[0];
        if (!candidate?.content?.parts) {
            const finishReason = candidate?.finishReason;
            console.error('Image processing failed.', { finishReason, safetyRatings: candidate?.safetyRatings });
            throw new Error(`Image processing failed. Reason: ${finishReason || 'No content returned from model.'}`);
        }
    
        for (const part of candidate.content.parts) {
            if (part.inlineData) {
                const base64ImageBytes: string = part.inlineData.data;
                return `data:${part.inlineData.mimeType};base64,${base64ImageBytes}`;
            }
        }
        throw new Error("No image was returned from the model for this prompt.");
    });
};


export const preprocessImage = async (imageDataUrl: string): Promise<string> => {
    const prompt = "Correct the perspective of this receipt. Make it look like a flat, top-down scan. De-skew and crop it tightly to the edges of the receipt. Do not change colors or add any effects.";
    return processImageWithPrompt(imageDataUrl, prompt);
};

export const enhanceForOcr = async (imageDataUrl: string): Promise<string> => {
    const prompt = "Convert this image of a receipt to a high-contrast black and white image. Preserve all text details to ensure maximum OCR accuracy. Remove any shadows or noise."
    return processImageWithPrompt(imageDataUrl, prompt);
}

export const performOcr = async (imageDataUrl: string): Promise<string> => {
  return withGeminiErrorHandling(async () => {
    const ai = getAiClient();
    const imagePart = fileToGenerativePart(imageDataUrl);
    const prompt = "Perform OCR on this image and extract all text content exactly as it appears.";
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [{ parts: [imagePart, { text: prompt }] }]
    });
  
    const text = response.text;
    if (typeof text !== 'string') {
        console.error('OCR failed. No text returned from model.', { response });
        throw new Error('OCR failed. No text was returned from the model.');
    }
    return text;
  });
};

export const analyzeImage = async (imageDataUrl: string, prompt: string): Promise<string> => {
    return withGeminiErrorHandling(async () => {
        const ai = getAiClient();
        const imagePart = fileToGenerativePart(imageDataUrl);
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: [{ parts: [imagePart, { text: prompt }] }]
        });
    
        const text = response.text;
        if (typeof text !== 'string') {
            console.error('Analysis failed. No text returned from model.', { response });
            throw new Error('Analysis failed. No text was returned from the model.');
        }
        return text;
    });
}


export const editImage = async (imageDataUrl: string, prompt: string): Promise<string> => {
    return withGeminiErrorHandling(async () => {
        const ai = getAiClient();
        const imagePart = fileToGenerativePart(imageDataUrl);
        const response: GenerateContentResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: [{
                parts: [
                    imagePart,
                    { text: prompt },
                ],
            }],
            config: {
                responseModalities: [Modality.IMAGE],
            },
        });
    
        const candidate = response.candidates?.[0];
        if (!candidate?.content?.parts) {
            const finishReason = candidate?.finishReason;
            console.error('Image editing failed.', { finishReason, safetyRatings: candidate?.safetyRatings });
            throw new Error(`Image editing failed. Reason: ${finishReason || 'No content returned from model.'}`);
        }
    
        for (const part of candidate.content.parts) {
            if (part.inlineData) {
                const base64ImageBytes: string = part.inlineData.data;
                return `data:${part.inlineData.mimeType};base64,${base64ImageBytes}`;
            }
        }
        throw new Error("No image was generated by the edit request.");
    });
};


export const generateImage = async (prompt: string): Promise<string> => {
    return withGeminiErrorHandling(async () => {
        const ai = getAiClient();
        const response = await ai.models.generateImages({
            model: 'imagen-4.0-generate-001',
            prompt,
            config: {
                numberOfImages: 1,
                outputMimeType: 'image/jpeg',
                aspectRatio: '1:1',
            },
        });
    
        const firstImage = response.generatedImages?.[0];
        if (firstImage?.image?.imageBytes) {
            const base64ImageBytes: string = firstImage.image.imageBytes;
            return `data:image/jpeg;base64,${base64ImageBytes}`;
        }
        
        console.error('Image generation failed.', { generationInfo: response.generationInfo });
        throw new Error("Image generation failed.");
    });
};
