// server.js （統合版）
import express from "express";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import path from "path";
import { Innertube } from "youtubei.js";
import { execSync } from "child_process";

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 静的ファイル配信（index.html, watch.html などを直接配信）
app.use(express.static(__dirname));  // ← これで /index.html, /watch.html が自動で配信される

// YouTubeクライアント（使ってないなら削除可）
let youtube;
(async () => {
  try {
    youtube = await Innertube.create();
    console.log("YouTube InnerTube client ready");
  } catch (e) {
    console.warn("InnerTube init failed", e);
  }
})();

// ルートで index.html を返す（任意だがわかりやすい）
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// watch.html を明示的に（なくてもOK）
app.get("/watch.html", (req, res) => {
  res.sendFile(path.join(__dirname, "watch.html"));
});

// ★ yt-dlp で署名付きURLを取得（オリジナルプレイヤー用）
// server.js の該当部分を以下のように修正または復活させる
app.get("/video", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: "video id required" });

  try {
    // yt-dlp で署名付きURLを取得（cookies必須）
    const output = execSync(
      `yt-dlp --cookies youtube-cookies.txt --js-runtimes node --remote-components ejs:github --sleep-requests 1 --user-agent "Mozilla/5.0" --get-url -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]" https://youtu.be/${videoId}`
    ).toString().trim().split("\n");

    const videoUrl = output[0] || "";
    const audioUrl = output[1] || videoUrl;  // 音声分離できない場合は同じURLを使う

    if (!videoUrl) {
      throw new Error("No valid stream URL extracted. Cookies may be expired.");
    }

    res.json({
      video: videoUrl,
      audio: audioUrl,
      source: "yt-dlp"
    });
  } catch (e) {
    console.error("yt-dlp error:", e.message, e.stack);
    res.status(500).json({
      error: "failed_to_extract_video",
      message: e.message.includes("Sign in") 
        ? "YouTubeがボット判定しました。youtube-cookies.txtを最新のものに更新してください" 
        : e.message
    });
  }
});

// ★ 360p・音声＋映像 合体（progressive）
app.get("/video360", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: "video id required" });

  try {
    const output = execSync(
      `yt-dlp --cookies youtube-cookies.txt \
--js-runtimes node \
--remote-components ejs:github \
--sleep-requests 1 \
--user-agent "Mozilla/5.0" \
--get-url \
-f "best[ext=mp4][height<=360]/best[ext=mp4]/best" \
https://youtu.be/${videoId}`
    ).toString().trim();

    if (!output) throw new Error("No valid 360p stream");

    res.json({
      video: output,
      audio: output,
      source: "yt-dlp-360p-progressive"
    });

  } catch (e) {
    console.error("yt-dlp 360p error:", e.message);
    res.status(500).json({
      error: "failed_to_extract_video_360",
      message: e.message
    });
  }
});


// プロキシ（動画チャンク配信用） ← 重要！これがないと403エラー多発
app.get("/proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("URL required");

  const range = req.headers.range || "bytes=0-";

  try {
    const response = await fetch(url, {
      headers: { Range: range }
    });

    const headers = {
      "Content-Type": response.headers.get("content-type") || "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Range": response.headers.get("content-range") || range,
      "Content-Length": response.headers.get("content-length")
    };

    res.writeHead(response.status, headers);
    response.body.pipe(res);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Proxy failed");
  }
});


// server.js に追加（既存の /proxy や他のルートの後でOK）

app.get("/thumb-proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) {
    console.log("No thumbnail URL");
    return res.status(400).send("URL required");
  }

  console.log(`Proxying thumbnail: ${url}`);

  const allowedHosts = ['yt3.ggpht.com', 'ggpht.com', 'googleusercontent.com', 'pipedproxy', 'private.coffee', 'kavin.rocks'];
  try {
    const urlObj = new URL(url);
    if (!allowedHosts.some(h => urlObj.hostname.includes(h))) {
      console.log(`Blocked invalid host: ${urlObj.hostname}`);
      return res.status(403).send("Invalid host");
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Referer": "https://www.youtube.com/",
        "Origin": "https://www.youtube.com",
        "Accept": "image/webp,*/*;q=0.8"
      },
      redirect: 'follow'
    });

    if (!response.ok) {
      const err = await response.text().catch(() => '');
      console.error(`Fetch failed ${response.status}: ${err}`);
      return res.status(response.status).send("Fetch error");
    }

    const buffer = await response.arrayBuffer();  // バイナリとして取得

    const headers = {
      "Content-Type": response.headers.get("content-type") || "image/webp",
      "Content-Length": buffer.byteLength,
      "Cache-Control": "public, max-age=604800",
      "Access-Control-Allow-Origin": "*",          // ← これ必須！ORB回避
      "Access-Control-Allow-Methods": "GET",
      "Vary": "Origin"
    };

    res.writeHead(200, headers);
    res.end(Buffer.from(buffer));  // バイナリ送信
  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(500).send("Proxy failed");
  }
});

// HLS用プロキシ（必要なら拡張）
app.get("/proxy-hls", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("URL required");

  try {
    const r = await fetch(url);
    let text = await r.text();

    // m3u8内のURLを /proxy にリライト
    text = text.replace(
      /(https?:\/\/[^\s]+)/g,
      (m) => m.includes("googlevideo.com") ? `/proxy?url=${encodeURIComponent(m)}` : m
    );

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    res.status(500).send("HLS proxy failed");
  }
});

// Piped API プロキシエンドポイント（CORS回避 + 負荷分散用）
const pipedInstances = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz'
];

app.get('/piped/*', async (req, res) => {
  const path = req.path.replace('/piped', '');
  const query = new URLSearchParams(req.query).toString();

  for (const base of pipedInstances) {
    const targetUrl = `${base}${path}${query ? '?' + query : ''}`;
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (response.ok) {
        const contentType = response.headers.get('content-type');
        res.setHeader('Content-Type', contentType || 'application/json');
        return response.body.pipe(res);
      }
      console.log(`Instance ${base} failed with ${response.status}`);
    } catch (e) {
      console.error(`Instance ${base} error:`, e.message);
    }
  }

  res.status(503).json({ error: 'All Piped instances failed' });
});

app.get("/download", async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).send("URL required");
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      console.error("Download fetch failed:", response.status);
      return res.status(response.status).send("Download fetch failed");
    }

    // 強制ダウンロード
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="video_360p.mp4"'
    );

    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") || "video/mp4"
    );

    response.body.pipe(res);

  } catch (err) {
    console.error("Download proxy error:", err);
    res.status(500).send("Download failed");
  }
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
