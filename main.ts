#!/usr/bin/env -S npx tsx

import fs from "node:fs";
import readline from "node:readline";
import got from "got";
import _ from "lodash";

import {
    LOG_FILE,
    PROD_LIKE_INSTANCE,
    NEW_VIEWS_INSTANCE,
    COUCHDB_USER,
    COUCHDB_PASSWORD,
} from "./config";

const sleep = async (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type ExtractedRequest = {
    view: "contacts_by_freetext" | "contacts_by_type_freetext" | "reports_by_freetext" | {};
    pathname: string;
    searchParams: URLSearchParams;
    fullPath: string;
}

const extractRequest = (line: string): ExtractedRequest | null => {
    const apiRegex = /GET \/medic\/_design\/medic-client\/_view\/(?<view>[a-z_]+_freetext)(?<querystring>[^\s]+)/;
    const haproxyRegex = /GET,\/medic\/_design\/medic-client\/_view\/(?<view>[a-z_]+_freetext)(?<querystring>[^,]+)/;

    let matches = apiRegex.exec(line);
    if (!matches || !matches.groups) {
        matches = haproxyRegex.exec(line);
    }
    if (!matches || !matches.groups) {
        return null;
    }

    const pathname = `/medic/_design/medic-client/_view/${matches.groups.view}`;
    const searchParams = new URLSearchParams(matches.groups.querystring);
    return {
        pathname,
        searchParams,
        view: matches.groups.view,
        fullPath: `${pathname}?${searchParams.toString()}`
    };
};

const requests = new Map<string, ExtractedRequest>();
let lineCount = 0;

const lineReader = readline.createInterface({ input: fs.createReadStream(LOG_FILE) });
lineReader.on("line", (line) => {
    lineCount++;
    const query = extractRequest(line);
    if (!query) {
        console.error(`malformed log on line ${line + 1}`, line);
        return;
    }

    requests.set(query.fullPath, query);
});

const done = new Promise(resolve => lineReader.on("close", resolve));
await done;

console.log(`Parsed ${lineCount} lines and found ${requests.size} unique requests`);

type SearchResponse = {
    total_rows: number;
    offset: number;
    rows: Array<{ id: string; key: string[]; value: string }>;
}

const makeRequest = async (instanceUrl: string, request: ExtractedRequest) => {
    const url = new URL(instanceUrl);
    url.username = COUCHDB_USER;
    url.password = COUCHDB_PASSWORD;
    url.pathname = request.pathname;
    for (const [key, value] of request.searchParams.entries()) {
        url.searchParams.set(key, value);
    }
    console.log(`GET ${url}`);
    const response = await got.get(url).json<SearchResponse>();
    return response;
};

const dumpResponse = async (request: ExtractedRequest, prodResponse: unknown, newViewsResponse: unknown) => {
    const dir = `./responses/${request.view}?${request.searchParams.toString()}`;
    if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
    }

    await Promise.all([
        fs.promises.writeFile(`${dir}/prod.json`, JSON.stringify(prodResponse, null, 4)),
        fs.promises.writeFile(`${dir}/new.json`, JSON.stringify(newViewsResponse, null, 4)),
    ]);
}

for (const request of requests.values()) {
    const [prodResponse, newViewsResponse] = await Promise.all([
        makeRequest(PROD_LIKE_INSTANCE, request),
        makeRequest(NEW_VIEWS_INSTANCE, request),
    ]);

    await dumpResponse(request, prodResponse, newViewsResponse);

    const diff = _.differenceWith(prodResponse.rows, newViewsResponse.rows, _.isEqual);
    if (diff) {
        console.log(diff);
    }

    await sleep(500);
}
