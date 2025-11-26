export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const { pathname, searchParams } = url;

        // Normalise path
        const path = pathname.replace(/^\/|\/$/g, "");
        const segments = path.split("/").filter(Boolean);

        // Simple health check
        if (segments.length === 0) {
            return new Response("Smart Bin Worker online", { status: 200 });
        }

        // JSON API alias: /api/bin/{id}
        if (segments[0] === "api" && segments[1] === "bin" && segments[2]) {
            const id = segments[2];
            if (request.method === "GET") {
                return handleBinJsonGet(id, env);
            }
            return new Response("Method not allowed", { status: 405 });
        }

        // Main routes: /bin/{id}...
        if (segments[0] === "bin" && segments[1]) {
            const id = segments[1];

            // /bin/{id}/photo
            if (segments[2] === "photo") {
                if (request.method === "GET") {
                    return handleBinPhotoGet(id, env);
                }
                if (request.method === "POST") {
                    return handleBinPhotoPost(request, id, env);
                }
                return new Response("Method not allowed", { status: 405 });
            }

            // /bin/{id} (HTML or JSON) + POST /bin/{id} (update metadata)
            if (segments.length === 2) {
                if (request.method === "GET") {
                    const format = searchParams.get("format") || "html";
                    if (format === "json") {
                        return handleBinJsonGet(id, env);
                    } else {
                        return handleBinHtmlGet(id, env);
                    }
                }
                if (request.method === "POST") {
                    return handleBinMetaPost(request, id, env);
                }
            }
        }

        return new Response("Not found", { status: 404 });
    }
};

/**
 * Load one bin row from D1.
 */
async function getBinRow(env, binId) {
    const stmt = env.BINS_DB
        .prepare("SELECT * FROM bins WHERE bin_id = ?")
        .bind(binId);

    const row = await stmt.first();
    return row || null;
}

/**
 * Upsert a bin row into D1.
 */
async function upsertBinRow(env, binId, data) {
    const now = Date.now();
    const existing = await getBinRow(env, binId);

    const case_code = data.case_code ?? existing?.case_code ?? null;
    const bin_type = data.bin_type ?? existing?.bin_type ?? null;
    const notes = data.notes ?? existing?.notes ?? null;
    const photo_key = data.photo_key ?? existing?.photo_key ?? null;

    if (existing) {
        await env.BINS_DB
            .prepare('UPDATE bins SET case_code = ?, bin_type = ?, notes = ?, photo_key = ?, updated_at = ? WHERE bin_id = ?')
            .bind(case_code, bin_type, notes, photo_key, now, binId)
            .run();
    } else {
        await env.BINS_DB
            .prepare('INSERT INTO bins (bin_id, case_code, bin_type, notes, photo_key, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(binId, case_code, bin_type, notes, photo_key, now)
            .run();
    }

    return await getBinRow(env, binId);
}

/**
 * GET /api/bin/{id} or /bin/{id}?format=json
 */
async function handleBinJsonGet(binId, env) {
    const row = await getBinRow(env, binId);

    if (!row) {
        return jsonResponse(
            {
                status: "not_found",
                bin_id: binId,
                message: "Bin not registered yet"
            },
            404
        );
    }

    const json = {
        status: "ok",
        bin_id: row.bin_id,
        case_code: row.case_code,
        bin_type: row.bin_type,
        notes: row.notes,
        photo_url: row.photo_key ? `/bin/${encodeURIComponent(binId)}/photo` : null,
        updated_at: row.updated_at
    };

    return jsonResponse(json, 200);
}

/**
 * GET /bin/{id} → simple landing HTML
 */
async function handleBinHtmlGet(binId, env) {
    const row = await getBinRow(env, binId);

    if (!row) {
        const html = `
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Bin ${escapeHtml(binId)}</title></head>
<body>
    <h2>Bin ${escapeHtml(binId)}</h2>
    <p>This bin is not registered yet.</p>
</body>
</html>`;
        return new Response(html, {
            status: 404,
            headers: { "Content-Type": "text/html; charset=utf-8" }
        });
    }

    const title = row.case_code
        ? `Bin ${row.bin_id} – Case ${row.case_code}`
        : `Bin ${row.bin_id}`;

    const imgTag = row.photo_key
        ? `<img src="/bin/${encodeURIComponent(binId)}/photo" style="max-width:100%;height:auto;" alt="Bin photo">`
        : '<p><em>No photo uploaded yet.</em></p>';

    const html = `
<!doctype html>
<html>
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
</head>
<body>
    <h2>${escapeHtml(title)}</h2>
    <p><strong>Bin type:</strong> ${escapeHtml(row.bin_type || "-")}</p>
    <p><strong>Notes:</strong> ${escapeHtml(row.notes || "-")}</p>
    ${row.case_code ? `<p><strong>Case:</strong> ${escapeHtml(row.case_code)}</p>` : ""}
    ${imgTag}
</body>
</html>`;

    return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
    });
}

/**
 * POST /bin/{id} - update metadata
 */
async function handleBinMetaPost(request, binId, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse(
            { error: "Expected JSON body with fields case_code/bin_type/notes" },
            400
        );
    }

    const data = {
        case_code: body.case_code,
        bin_type: body.bin_type,
        notes: body.notes
    };

    const row = await upsertBinRow(env, binId, data);
    return jsonResponse({ status: "ok", bin: row }, 200);
}

/**
 * POST /bin/{id}/photo - upload a photo
 */
async function handleBinPhotoPost(request, binId, env) {
    const contentType = request.headers.get("content-type") || "application/octet-stream";
    const body = await request.arrayBuffer();

    const timestamp = Date.now();
    const key = `bins/${encodeURIComponent(binId)}/${timestamp}.img`;

    await env.BINS_BUCKET.put(key, body, {
        httpMetadata: { contentType }
    });

    // Update metadata with latest photo
    const row = await upsertBinRow(env, binId, { photo_key: key });

    return jsonResponse(
        {
            status: "ok",
            bin_id: binId,
            photo_key: key,
            photo_url: `/bin/${encodeURIComponent(binId)}/photo`,
            bin: row
        },
        200
    );
}

/**
 * GET /bin/{id}/photo - stream photo from R2
 */
async function handleBinPhotoGet(binId, env) {
    const row = await getBinRow(env, binId);

    if (!row || !row.photo_key) {
        return new Response("No photo for this bin", { status: 404 });
    }

    const object = await env.BINS_BUCKET.get(row.photo_key);

    if (!object) {
        return new Response("Photo object not found", { status: 404 });
    }

    const headers = new Headers();
    const meta = object.httpMetadata || {};
    headers.set("Content-Type", meta.contentType || "image/jpeg");
    if (meta.cacheControl) headers.set("Cache-Control", meta.cacheControl);

    return new Response(object.body, { status: 200, headers });
}

// Helper functions
function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" }
    });
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
