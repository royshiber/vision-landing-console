import { GoogleGenerativeAI } from '@google/generative-ai';
import { getGeminiModelChain } from './gemini-model.mjs';
import { logger } from './logger.mjs';

/**
 * Why: Feature Designer system prompt instructs Gemini to act as an ArduPilot core developer
 * and output a structured JSON payload containing both the C++ implementation and the
 * parameter schema — eliminating the need for fragile regex parsing.
 */
const FEATURE_SYSTEM_PROMPT = `You are an expert ArduPilot core developer for ArduPlane fixed-wing aircraft.
Your task: translate a user's natural language description into a complete custom flight controller feature.

OUTPUT FORMAT — respond ONLY with a single valid JSON object (no markdown, no code fences):
{
  "feature_name": "Short English name, 2-5 words",
  "description": "One clear sentence describing what this feature does",
  "cpp_code": "Full C++ implementation as a single string (use \\n for newlines). Include: class header + source + AP_Param var_info table.",
  "params": [
    {
      "key": "PREFIX_PARAMNAME",
      "type": "FLOAT|INT8|INT16|INT32",
      "default_value": 0,
      "description": "Clear description of what this parameter controls",
      "description_he": "תיאור קצר בעברית של מה שהפרמטר שולט בו",
      "units": "m/s|deg|bool|enum|Hz|s|cm|cdeg|",
      "min_val": null,
      "max_val": null
    }
  ]
}

PARAMETER NAMING RULES:
- Choose a 2-4 char UPPERCASE prefix unique to this feature (e.g. CSW_ for crosswind, EAL_ for emergency auto-level)
- Full param key: PREFIX_SHORTNAME, max 16 chars total, UPPERCASE only
- Always include an ENABLE param (INT8, default 0, min 0, max 1) as the first param
- Typically 3-8 parameters per feature; more is fine if the feature is complex

C++ CODE STYLE:
- Follow ArduPilot AP_Param conventions exactly
- Include AP_GROUPINFO entries in var_info[] for every param
- Include a brief update() method with realistic logic (use AP_Math, AP_Hal references)
- Add // comments explaining the logic

LANGUAGE: Feature name and description in English. Parameter "description" in English. Parameter "description_he" in Hebrew (concise, 1 sentence).
All JSON string values must be properly escaped.`;

const CHAT_SYSTEM_PROMPT = `You are an expert ArduPilot AI assistant embedded in ArduLab — an AI-powered ArduPilot feature development environment.
You are having a conversation with a developer about a specific ArduPilot feature they created.

You can do two things:
1. Answer questions, explain the code, discuss parameters, suggest improvements — in a natural conversational style.
2. If the user asks to CHANGE, FIX, IMPROVE, or UPDATE the code/parameters, also provide the updated feature.

RESPONSE FORMAT — always respond with a single valid JSON object:

For conversational responses (questions, explanations, discussions):
{
  "type": "chat",
  "message": "Your natural language response (use the same language the user used — Hebrew or English)"
}

For code updates (when user asks to change/fix/improve something in the feature):
{
  "type": "update",
  "message": "Brief explanation of what you changed (use the same language the user used)",
  "feature_name": "Updated feature name",
  "description": "Updated description",
  "cpp_code": "Full updated C++ code",
  "params": [{ "key": "...", "type": "...", "default_value": 0, "description": "...", "description_he": "תיאור בעברית", "units": "", "min_val": null, "max_val": null }]
}

IMPORTANT: 
- Respond in the SAME LANGUAGE as the user (Hebrew → Hebrew, English → English)
- For simple questions or discussion, use type "chat" — do NOT regenerate code unnecessarily
- Always be helpful, clear, and technically accurate`;

/**
 * Call Gemini to generate (or refine) an ArduPilot C++ feature from a natural language description.
 *
 * @param {string} description  User's description (Hebrew or English)
 * @param {Array<{role: 'user'|'assistant', content: string}>} history  Prior conversation turns
 * @returns {Promise<{feature_name: string, description: string, cpp_code: string, params: Array}>}
 */
export async function generateFeature(description, history = []) {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('feature-designer: GEMINI_API_KEY not set, returning offline placeholder');
    return buildOfflineFallback(description);
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const modelChain = getGeminiModelChain();

  // Build Gemini conversation history from prior turns.
  const geminiHistory = [];
  for (const turn of history) {
    geminiHistory.push({ role: turn.role === 'user' ? 'user' : 'model', parts: [{ text: turn.content }] });
  }

  const isRefinement = history.length > 0;
  const userMessage = isRefinement
    ? `Refine the feature based on this feedback: "${description}"\n\nReturn the complete updated JSON (all fields, full cpp_code).`
    : `Feature request: "${description}"\n\nGenerate a complete ArduPlane C++ implementation with parameter schema.`;

  let lastErr = null;
  for (const modelId of modelChain) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: { responseMimeType: 'application/json', temperature: 0.65, maxOutputTokens: 8192 },
        systemInstruction: FEATURE_SYSTEM_PROMPT,
      });
      const chat = model.startChat({ history: geminiHistory });
      const result = await chat.sendMessage(userMessage);
      const text = result.response.text();

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        else throw new Error('No valid JSON found in response');
      }
      validateFeatureOutput(parsed);
      logger.info({ modelId }, 'feature-designer: success');
      return parsed;
    } catch (err) {
      const msg = err?.message ?? '';
      const isTransient = msg.includes('503') || msg.includes('Service Unavailable')
        || msg.includes('currently') || msg.includes('overloaded') || msg.includes('404');
      logger.warn({ modelId, err: msg }, 'feature-designer: model attempt failed');
      lastErr = err;
      if (!isTransient) break;
    }
  }

  logger.error({ err: lastErr }, 'feature-designer: all models failed');
  const raw = lastErr?.message ?? '';
  if (raw.includes('503') || raw.includes('Service Unavailable') || raw.includes('overloaded')) {
    throw new Error('שירות ה-AI עמוס כרגע — נסה שוב בעוד מספר שניות.');
  }
  if (raw.includes('quota') || raw.includes('RESOURCE_EXHAUSTED')) {
    throw new Error('מכסת ה-API הגיעה לסיום — בדוק את מכסת Gemini שלך.');
  }
  throw new Error('שירות ה-AI לא זמין כרגע — נסה שוב.');
}

function validateFeatureOutput(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Response is not an object');
  if (typeof obj.feature_name !== 'string' || !obj.feature_name.trim()) throw new Error('Missing feature_name');
  if (!Array.isArray(obj.params) || obj.params.length === 0) throw new Error('No params in response');
  // Ensure every param has at minimum a key and type
  for (const p of obj.params) {
    if (!p.key || typeof p.key !== 'string') throw new Error(`Invalid param entry: missing key`);
  }
}

/**
 * Offline fallback when no Gemini API key is configured.
 * Returns a minimal but structurally valid feature so the UI stays functional.
 */
/**
 * Chat with Gemini about an existing feature. Supports both conversational questions
 * and code-update requests. Returns { type, message, ...featureFields? }
 */
export async function chatWithFeature(message, feature, history = []) {
  if (!process.env.GEMINI_API_KEY) {
    return { type: 'chat', message: 'GEMINI_API_KEY לא מוגדר — לא ניתן לשוחח עם AI במצב offline.' };
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const modelChain = getGeminiModelChain();

  const featureContext = `Current feature context:
Name: ${feature.name}
Description: ${feature.description}
Parameters: ${JSON.stringify((feature.params || []).map(p => ({ key: p.key, type: p.type, description: p.description, default_value: p.default_value })))}
Code (first 800 chars): ${(feature.cpp_code || '').slice(0, 800)}`;

  const geminiHistory = [
    { role: 'user', parts: [{ text: featureContext }] },
    { role: 'model', parts: [{ text: JSON.stringify({ type: 'chat', message: 'הבנתי. אני מוכן לענות על שאלות או לעדכן את הפיצ\'ר.' }) }] },
    ...history.slice(-8).map(t => ({ role: t.role === 'user' ? 'user' : 'model', parts: [{ text: t.content }] })),
  ];

  let lastErr = null;
  for (const modelId of modelChain) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens: 8192 },
        systemInstruction: CHAT_SYSTEM_PROMPT,
      });
      const chat = model.startChat({ history: geminiHistory });
      const result = await chat.sendMessage(message);
      const text = result.response.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch {
        const m = text.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : { type: 'chat', message: text };
      }
      if (!parsed.type) parsed.type = 'chat';
      if (!parsed.message) parsed.message = 'תגובה לא תקינה מהAI';
      return parsed;
    } catch (err) {
      const msg = err?.message ?? '';
      const isTransient = msg.includes('503') || msg.includes('Service Unavailable')
        || msg.includes('currently') || msg.includes('overloaded') || msg.includes('404');
      lastErr = err;
      logger.warn({ modelId, err: msg }, 'feature-designer chat: model attempt failed');
      if (!isTransient) break;
    }
  }

  logger.error({ err: lastErr }, 'feature-designer: chatWithFeature all models failed');
  const raw = lastErr?.message ?? '';
  if (raw.includes('503') || raw.includes('Service Unavailable') || raw.includes('overloaded')) {
    throw new Error('שירות ה-AI עמוס כרגע — נסה שוב בעוד מספר שניות.');
  }
  throw new Error('שירות ה-AI לא זמין כרגע — נסה שוב.');
}

function buildOfflineFallback(description) {
  const shortDesc = String(description || '').slice(0, 80);
  const prefix = 'CUST';
  return {
    feature_name: 'Custom Feature (offline)',
    description: shortDesc || 'Custom ArduPilot feature',
    cpp_code: [
      `// Custom Feature: ${shortDesc}`,
      '// NOTE: No Gemini API key configured — this is an offline placeholder.',
      '',
      '#pragma once',
      '#include "AP_Param.h"',
      '#include <AP_HAL/AP_HAL.h>',
      '',
      'class CustomFeature {',
      'public:',
      '    CustomFeature() {}',
      '',
      '    // Call from ArduPlane::update() at 50 Hz',
      '    void update();',
      '',
      '    static const struct AP_Param::GroupInfo var_info[];',
      '',
      'private:',
      '    AP_Int8  _enable;',
      '};',
      '',
      'const AP_Param::GroupInfo CustomFeature::var_info[] = {',
      '    // @Param: ENABLE',
      '    // @DisplayName: Enable Custom Feature',
      '    // @Description: Enable this custom feature (0=disabled, 1=enabled)',
      '    // @Values: 0:Disabled,1:Enabled',
      '    // @User: Standard',
      '    AP_GROUPINFO("ENABLE", 0, CustomFeature, _enable, 0),',
      '    AP_GROUPEND',
      '};',
      '',
      'void CustomFeature::update() {',
      '    if (!_enable) return;',
      '    // TODO: feature implementation',
      '}',
    ].join('\n'),
    params: [
      {
        key: `${prefix}_ENABLE`,
        type: 'INT8',
        default_value: 0,
        description: 'Enable this custom feature (0=disabled, 1=enabled)',
        units: 'bool',
        min_val: 0,
        max_val: 1,
      },
    ],
  };
}
