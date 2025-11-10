
import { GoogleGenAI, Modality, GenerateContentResponse } from "@google/genai";

const getAiClient = () => {
  if (!process.env.API_KEY) {
    throw new Error("API_KEY environment variable not set");
  }
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
}

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
};

export const analyzeImage = async (imageDataUrl: string, prompt: string): Promise<string> => {
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
}


export const editImage = async (imageDataUrl: string, prompt: string): Promise<string> => {
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
};


export const generateImage = async (prompt: string): Promise<string> => {
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
};
