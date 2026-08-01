import OpenAI from "openai";

export function getContactBoxConfig() {
  const apiKey =
    process.env.CONTACTBOX_API_KEY ||
    process.env.OPENAI_API_KEY ||
    "";
  const baseURL = (
    process.env.CONTACTBOX_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://api.contactboxtools.me/v1"
  ).replace(/\/$/, "");
  const model =
    process.env.CONTACTBOX_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-5.6-terra";

  return { apiKey, baseURL, model, configured: Boolean(apiKey) };
}

export function createContactBoxClient() {
  const { apiKey, baseURL } = getContactBoxConfig();
  if (!apiKey) {
    throw new Error("CONTACTBOX_API_KEY (or OPENAI_API_KEY) is not set");
  }
  return new OpenAI({ apiKey, baseURL });
}
