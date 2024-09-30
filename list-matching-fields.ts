#!/usr/bin/env -S npx tsx

import fs from "node:fs";
import got from "got";
import pLimit from "p-limit";
import _ from "lodash";

import {
    PROD_LIKE_INSTANCE,
    COUCHDB_USER,
    COUCHDB_PASSWORD,
} from "./config";

type Match = {
    query: string;
    matchedKey: string;
    matchedValue: string;
};

const processDocsLimit = pLimit(5);
const found: Record<string, Match[]> = {};
const views = {
    contacts_by_freetext(doc: any, emit: (key: [string], value: string, originKey?: string) => void) {
        var skip = [ '_id', '_rev', 'type', 'refid', 'geolocation' ];
      
        var usedKeys: string[] = [];
        var emitMaybe = function(key, value, originKey?) {
          if (usedKeys.indexOf(key) === -1 && // Not already used
              key.length > 2 // Not too short
          ) {
            usedKeys.push(key);
            emit([key], value, originKey);
          }
        };
      
        var emitField = function(key, value, order) {
          if (!key || !value) {
            return;
          }
          key = key.toLowerCase();
          if (skip.indexOf(key) !== -1 || /_date$/.test(key)) {
            return;
          }
          if (typeof value === 'string') {
            value = value.toLowerCase();
            value.split(/\s+/).forEach(function(word) {
              emitMaybe(word, order, key);
            });
          }
          if (typeof value === 'number' || typeof value === 'string') {
            emitMaybe(key + ':' + value, order);
          }
        };
      
        var types = [ 'district_hospital', 'health_center', 'clinic', 'person' ];
        var idx;
        if (doc.type === 'contact') {
          idx = types.indexOf(doc.contact_type);
          if (idx === -1) {
            idx = doc.contact_type;
          }
        } else {
          idx = types.indexOf(doc.type);
        }
      
        if (idx !== -1) {
          var dead = !!doc.date_of_death;
          var muted = !!doc.muted;
          var order = dead + ' ' + muted + ' ' + idx + ' ' + (doc.name && doc.name.toLowerCase());
          Object.keys(doc).forEach(function(key) {
            emitField(key, doc[key], order);
          });
        }
    },
    reports_by_freetext(doc: any, emit: (key: [string], value: string, originKey?: string) => void) {
        var skip = [ '_id', '_rev', 'type', 'refid', 'content' ];

        var usedKeys: string[] = [];
        var emitMaybe = function(key, value, originKey?) {
            if (usedKeys.indexOf(key) === -1 && // Not already used
                key.length > 2 // Not too short
            ) {
            usedKeys.push(key);
            emit([key], value, originKey);
            }
        };

        var emitField = function(key, value, reportedDate, originKey) {
            if (!key || !value) {
            return;
            }
            key = key.toLowerCase();
            if (skip.indexOf(key) !== -1 || /_date$/.test(key)) {
            return;
            }
            if (typeof value === 'string') {
            value = value.toLowerCase();
            value.split(/\s+/).forEach(function(word) {
                emitMaybe(word, reportedDate, originKey);
            });
            }
            if (typeof value === 'number' || typeof value === 'string') {
            emitMaybe(key + ':' + value, reportedDate, originKey);
            }
        };

        if (doc.type === 'data_record' && doc.form) {
            Object.keys(doc).forEach(function(key) {
            emitField(key, doc[key], doc.reported_date, key);
            });
            if (doc.fields) {
            Object.keys(doc.fields).forEach(function(key) {
                emitField(key, doc.fields[key], doc.reported_date, `fields.${key}`);
            });
            }
            if (doc.contact && doc.contact._id) {
            emitMaybe('contact:' + doc.contact._id.toLowerCase(), doc.reported_date, 'contact._id');
            }
        }
    },
};
const makeRequest = async (instanceUrl: string, docId: string) => {
    const url = new URL(instanceUrl);
    url.username = COUCHDB_USER;
    url.password = COUCHDB_PASSWORD;
    url.pathname = `/medic/${docId}`;
    const response = await got.get(url).json<any>();
    return response;
};

for await (const filePath of fs.promises.glob("./responses/**/prod.json")) {
    // console.log("filePath", filePath);
    const requestPath = filePath.slice("responses/".length, -"/prod.json".length);
    const view = requestPath.slice(0, requestPath.indexOf("?"));
    const params = new URLSearchParams(requestPath.slice(requestPath.indexOf("?")));
    // console.log({ view, params });
    if (!params.has("startkey")) {
        continue;
    }

    const searchKey = params.get("startkey")!.replaceAll(/\W/g, "");
    const rawResponse = await fs.promises.readFile(filePath);
    const response = JSON.parse(rawResponse.toString());
    const emit = (doc: any) => (key: [string], value: string, originKey?: string) => {
        if (key[0].startsWith(searchKey)) {
            let nextValue = found[originKey!] ?? []
            nextValue.push({ query: searchKey, matchedKey: key[0], matchedValue: _.get(doc, originKey!) })
            found[originKey!] = nextValue;
        }
    };
    await doSomething(view, response, emit);
}

console.log(Object.keys(found));

await fs.promises.writeFile("./found.json", JSON.stringify(found, null, 4), "utf8");
await fs.promises.writeFile("./found_fields.json", JSON.stringify(Object.keys(found), null, 4), "utf8");

type SearchResponse = {
    total_rows: number;
    offset: number;
    rows: Array<{ id: string; key: string[]; value: string }>;
}

async function doSomething(view: string, response: SearchResponse, emit: (doc: any) => (key: [string], value) => void) {
    await Promise.all(
        response.rows.map(
            row => processDocsLimit(async () => {
                const res = await makeRequest(PROD_LIKE_INSTANCE, row.id);
                views[view](res, emit(res));
            }),
        ),
    );
}

