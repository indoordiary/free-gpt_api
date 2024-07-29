export const config = {
  supportsResponseStreaming: true,
};

import axios from "axios";
import https from "https";
import { encode } from "gpt-3-encoder";
import { randomUUID } from "crypto";
import jsSHA from "jssha/dist/sha3";

// Constants for the server and API configuration
const baseUrl = "https://chat.openai.com";
const apiUrl = `${baseUrl}/backend-anon/conversation`;

const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const cores = [8, 12, 16, 24];
const screens = [3000, 4000, 6000];
function getConfig() {
  const core = cores[Math.floor(Math.random() * cores.length)];
  const screen = screens[Math.floor(Math.random() * screens.length)];
  return [core + screen, "" + new Date(), 4294705152, 0, userAgent];
}
async function generateAnswer(seed, difficulty) {
  let hash = null;
  let config = getConfig();
  for (let attempt = 0; attempt < 100000; attempt++) {
    config[3] = attempt;
    const configBase64 = Buffer.from(JSON.stringify(config)).toString("base64");
    const hashInput = seed + configBase64;
    const shaObj = new jsSHA("SHA3-512", "TEXT", { encoding: "UTF8" });
    shaObj.update(hashInput);
    const hash = shaObj.getHash("HEX");
    if (hash.substring(0, difficulty.length) <= difficulty) {
      return "gAAAAAB" + configBase64;
    }
  }
  hash = Buffer.from(`"${seed}"`).toString("base64");
  return "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + hash;
}

function GenerateCompletionId(prefix = "cmpl-") {
  const characters =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const length = 28;

  for (let i = 0; i < length; i++) {
    prefix += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return prefix;
}

async function* chunksToLines(chunksAsync) {
  let previous = "";
  for await (const chunk of chunksAsync) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    previous += bufferChunk;
    let eolIndex;
    while ((eolIndex = previous.indexOf("\n")) >= 0) {
      // line includes the EOL
      const line = previous.slice(0, eolIndex + 1).trimEnd();
      if (line === "data: [DONE]") break;
      if (line.startsWith("data: ")) yield line;
      previous = previous.slice(eolIndex + 1);
    }
  }
}

async function* linesToMessages(linesAsync) {
  for await (const line of linesAsync) {
    const message = line.substring("data :".length);

    yield message;
  }
}

async function* StreamCompletion(data) {
  yield* linesToMessages(chunksToLines(data));
}

// Setup axios instance for API requests with predefined configurations
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "oai-language": "en-US",
    origin: baseUrl,
    pragma: "no-cache",
    referer: baseUrl,
    "sec-ch-ua":
      '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": userAgent,
  },
});


// Middleware to handle chat completions
export default async function handleChatCompletion(req, res) {
  const host = req.headers.host;
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  } else if (req.method !== "POST") {
    res.status(405).end();
    return;
  }
  const authToken = process.env.AUTH_TOKEN;
  const reqAuthToken = req.headers.authorization;
  if (authToken && reqAuthToken !== `Bearer ${authToken}`) {
    res.status(401).end();
    return;
  }

  const oaiDeviceId = randomUUID();
  let token, proofofwork;
  try {
    const myResponse = await axiosInstance.post(
      `${baseUrl}/backend-anon/sentinel/chat-requirements`,
      {},
      {
        headers: { "oai-device-id": oaiDeviceId },
      }
    );
    token = myResponse.data.token;
    proofofwork = myResponse.data.proofofwork;
    console.log(`成功获取 pow 和令牌。`);
  } catch (error) {
    console.log("获取令牌出错:", error.message);
  }
  const { seed, difficulty } = proofofwork;
  const proof = await generateAnswer(seed, difficulty);

  try {
    const body = {
      action: "next",
      messages: req.body.messages.map((message) => ({
        author: { role: message.role },
        content: { content_type: "text", parts: [message.content] },
      })),
      parent_message_id: randomUUID(),
      model: "text-davinci-002-render-sha",
      timezone_offset_min: -180,
      suggestions: [],
      history_and_training_disabled: true,
      conversation_mode: { kind: "primary_assistant" },
      websocket_request_id: randomUUID(),
    };

    let promptTokens = 0;
    let completionTokens = 0;

    for (let message of req.body.messages) {
      promptTokens += encode(message.content).length;
    }

    const response = await axiosInstance.post(apiUrl, body, {
      responseType: "stream",
      headers: {
        "oai-device-id": oaiDeviceId,
        "openai-sentinel-chat-requirements-token": token,
        "Openai-Sentinel-Proof-Token": proof,
      },
    });
    console.log(
      "Request:",
      `${req.method} ${req.originalUrl}`,
      `${req.body?.messages?.length || 0} messages`,
      req.body.stream ? "(stream-enabled)" : "(stream-disabled)",
      `oaiResponse: ${response.status} ${response.statusText}`
    );
    // Set the response headers based on the request type
    if (req.body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
    } else {
      res.setHeader("Content-Type", "application/json");
    }

    let fullContent = "";
    let requestId = GenerateCompletionId("chatcmpl-");
    let created = Date.now();
    let finish_reason = null;

    for await (const message of StreamCompletion(response.data)) {
      if (message.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}.\d{6}$/)) {
        continue;
      }
      const parsed = JSON.parse(message);

      let content = parsed?.message?.content?.parts[0] ?? "";
      let status = parsed?.message?.status ?? "";

      for (let message of req.body.messages) {
        if (message.content === content) {
          content = "";
          break;
        }
      }
      switch (status) {
        case "in_progress":
          finish_reason = null;
          break;
        case "finished_successfully":
          let finish_reason_data =
            parsed?.message?.metadata?.finish_details?.type ?? null;
          switch (finish_reason_data) {
            case "max_tokens":
              finish_reason = "length";
              break;
            case "stop":
            default:
              finish_reason = "stop";
          }
          break;
        default:
          finish_reason = null;
      }

      if (content === "") continue;

      let completionChunk = content.replace(fullContent, "");

      completionTokens += encode(completionChunk).length;

      if (req.body.stream) {
        let response = {
          id: requestId,
          created: created,
          object: "chat.completion.chunk",
          model: "gpt-3.5-turbo",
          choices: [
            {
              delta: {
                content: completionChunk,
              },
              index: 0,
              finish_reason: finish_reason,
            },
          ],
        };

        res.write(`data: ${JSON.stringify(response)}\n\n`);
      }

      fullContent = content.length > fullContent.length ? content : fullContent;
    }

    if (req.body.stream) {
      res.write(
        `data: ${JSON.stringify({
          id: requestId,
          created: created,
          object: "chat.completion.chunk",
          model: "gpt-3.5-turbo",
          choices: [
            {
              delta: {
                content: "",
              },
              index: 0,
              finish_reason: finish_reason,
            },
          ],
        })}\n\n`
      );
    } else {
      res.write(
        JSON.stringify({
          id: requestId,
          created: created,
          model: "gpt-3.5-turbo",
          object: "chat.completion",
          choices: [
            {
              finish_reason: finish_reason,
              index: 0,
              message: {
                content: fullContent,
                role: "assistant",
              },
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        })
      );
    }

    res.end();
  } catch (error) {
    let errorMessages;
    if (error.response?.status == 429) {
      console.log("oaiResponse: 429 Too Many Request!");
      errorMessages = "Too Many Request!";
    } else if (error.response?.status != undefined) {
      console.log(
        "oaiResponse:",
        error.response?.statusm,
        error.response?.statusText,
        error.name
      );
      errorMessages = error.response?.statusText;
    } else {
      console.log("connect error:", error.message);
      errorMessages = error.message;
    }
    if (!res.headersSent)
      res.writeHead(error.response?.status ?? 502, {
        "Content-Type": "application/json",
      });
    res.write(
      JSON.stringify({
        status: false,
        error: {
          message: errorMessages,
          type: "invalid_request_error",
          origin: error,
        },
      })
    );
    res.end();
  }
}
