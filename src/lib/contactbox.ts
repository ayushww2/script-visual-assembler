import OpenAI from "openai";
import {
  getContactBoxApiKey,
  getContactBoxBaseUrl,
  getContactBoxModel,
} from "@/lib/env";

export function getContactBoxConfig() {
  const apiKey = getContactBoxApiKey();
  const baseURL = getContactBoxBaseUrl();
  const model = getContactBoxModel();
  return { apiKey, baseURL, model, configured: Boolean(apiKey) };
}

export function createContactBoxClient() {
  const { apiKey, baseURL } = getContactBoxConfig();
  if (!apiKey) {
    throw new Error("CONTACTBOX_API_KEY (or OPENAI_API_KEY) is not set");
  }
  return new OpenAI({ apiKey, baseURL });
}
