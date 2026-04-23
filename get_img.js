// const { mkdir, writeFile } = require("node:fs/promises");
// const { dirname, resolve } = require("node:path");
import OpenAI from "openai";
import {mkdir, writeFile} from "node:fs/promises"
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const apiKey = process.env.OPENAI_API_KEY;
const client = new OpenAI(
    {
        baseURL: "http://127.0.0.1:8317/v1",
        apiKey: apiKey
    } 
)


if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
}

const BASE_URL = (process.env.OPENAI_BASE_URL || "http://127.0.0.1:8317/v1").replace(/\/+$/, "");
const RESPONSES_MODEL = process.env.RESPONSES_MODEL || "gpt-5.4";
const IMAGE_MODEL = "gpt-image-2";
let PROMPT = process.argv.slice(2).join(" ").trim() || "Generate a clean product shot of a glass honey jar on a light background.";
PROMPT = '架空のアニメ映画のポスターをGPT image2で作成。'
const SIZE = process.env.IMAGE_SIZE || "auto";
const QUALITY = process.env.IMAGE_QUALITY || "high";
const FORMAT = (process.env.IMAGE_FORMAT || "png").toLowerCase();
const BACKGROUND = process.env.IMAGE_BACKGROUND || "opaque";

function normalizeBase64(value) {
    return value.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "").trim();
}

function parseSseChunk(chunk) {
    const lines = chunk
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean);

    let eventName = "";
    const dataLines = [];

    for (const line of lines) {
        if (line.startsWith(":")) {
            continue;
        }

        if (line.startsWith("event:")) {
            eventName = line.slice("event:".length).trim();
            continue;
        }

        if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).trim());
        }
    }

    return {
        eventName,
        data: dataLines.join("\n"),
    };
}

function extractImageBase64(eventName, payload) {
    if (
        eventName === "response.output_item.done" &&
        payload?.item?.type === "image_generation_call" &&
        typeof payload.item.result === "string" &&
        payload.item.result.length > 0
    ) {
        return payload.item.result;
    }

    if (
        payload?.type === "image_generation_call" &&
        typeof payload.result === "string" &&
        payload.result.length > 0
    ) {
        return payload.result;
    }

    if (eventName === "response.completed" && Array.isArray(payload?.response?.output)) {
        const imageItem = payload.response.output.find(
            (item) => item?.type === "image_generation_call" && typeof item.result === "string"
        );

        if (imageItem?.result) {
            return imageItem.result;
        }
    }

    return "";
}

async function requestImageGeneration(prompt) {
    const response = await fetch(`${BASE_URL}/responses`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
        },
        body: JSON.stringify({
            model: RESPONSES_MODEL,
            input: prompt,
            stream: true,
            tool_choice: {
                type: "image_generation",
            },
            tools: [
                {
                    type: "image_generation",
                    model: IMAGE_MODEL,
                    size: SIZE,
                    quality: QUALITY,
                    output_format: FORMAT,
                    background: BACKGROUND,
                },
            ],
        }),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}\n${await response.text()}`);
    }

    if (!response.body) {
        throw new Error("Response body is empty.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalImageBase64 = "";

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        // console.log('///////////')
        // console.log(buffer)
        const chunks = buffer.split(/\r?\n\r?\n/);
        // console.log(chunks)
        buffer = chunks.pop() || "";

        for (const chunk of chunks) {
            const { eventName, data } = parseSseChunk(chunk);

            if (!data) {
                continue;
            }

            if (data === "[DONE]") {
                return finalImageBase64;
            }

            const payload = JSON.parse(data);
            const imageBase64 = extractImageBase64(eventName || payload?.type || "", payload);

            if (imageBase64) {
                finalImageBase64 = imageBase64;
            }
        }
    }

    return finalImageBase64;
}


export async function gen_img(prompt) {
    console.log("base_url:", BASE_URL);
    console.log("responses_model:", RESPONSES_MODEL);
    console.log("image_model:", IMAGE_MODEL);
    // return '/Users/Regenin/Code/oai_playground/output/generated-1776942198610.png'
    // console.log("prompt:", PROMPT);
    const imageBase64 = await requestImageGeneration(prompt);
    if (!imageBase64) {
        return "[ERROR]:No final image returned from /v1/responses.";
    }
    const outputPath = resolve("output", `generated-${Date.now()}.${FORMAT}`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(normalizeBase64(imageBase64), "base64"));

    console.log("saved:", outputPath);
    return outputPath
}


export async function get_discrption_from_img(img_url) {
    // return 'testtesttesttesttest'
    const stream = await client.responses.create({
    model: "gpt-5.4",
    stream: true,
    input: [
        {
        role: "user",
        content: [
            { type: "input_text", text: "请你为这张图片生成适合 gpt image 2的描述，**只**生成描述,不要加其他东西" },
            {
            type: "input_image",
            image_url: img_url
            }
        ]
        }
    ]
    })

    let text = ''
    for await (const res_chunk of stream) {
        if (res_chunk.type === "response.output_text.delta") {
            text += res_chunk.delta
            console.log(text)

        }
    }
    return text

}


async function main() {
    console.log("base_url:", BASE_URL);
    console.log("responses_model:", RESPONSES_MODEL);
    console.log("image_model:", IMAGE_MODEL);
    console.log("prompt:", PROMPT);

    const imageBase64 = await requestImageGeneration();

    if (!imageBase64) {
        throw new Error("No final image returned from /v1/responses.");
    }

    const outputPath = resolve("output", `generated-${Date.now()}.${FORMAT}`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(normalizeBase64(imageBase64), "base64"));

    console.log("saved:", outputPath);
}

const isMain = process.argv[0] && import.meta.url === pathToFileURL(process.argv[0]).href
if (isMain){main().catch((err)=>console.log(err))}
