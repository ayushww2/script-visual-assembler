import { z } from "zod";

export const googleSearchSchema = z.object({
  query: z.string().min(1),
  entityContext: z.string().min(1),
  whyGoogle: z.string().min(1),
  relatedBeatIds: z.array(z.string()).min(1),
  priority: z.number().min(0).max(100).default(50),
  alternateQueries: z.array(z.string()).optional(),
});

export const aiGenerateSchema = z.object({
  subject: z.string().min(1),
  visualIdea: z.string().min(1),
  whyAiNotGoogle: z.string().min(1),
  relatedBeatIds: z.array(z.string()).min(1),
  priority: z.number().min(0).max(100).default(50),
});

export const dividerResultSchema = z.object({
  googleSearches: z.array(googleSearchSchema),
  aiGenerate: z.array(aiGenerateSchema).default([]),
});

export type GoogleSearchPack = z.infer<typeof googleSearchSchema>;
export type AiGenerateItem = z.infer<typeof aiGenerateSchema>;
export type DividerResult = z.infer<typeof dividerResultSchema>;

export type Beat = {
  id: string;
  text: string;
  start?: number;
  end?: number;
};
