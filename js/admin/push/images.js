// ==========================================================================
// admin/push/images.js — pictures for notifications.
//
//   1. prepare()    a photo from the admin's phone / computer → a small JPEG (picture) or PNG (icon) made right in the browser.
//                   An upload is therefore always small, always a type the server accepts, and carries no camera data
//                   (re-drawing a picture on a canvas drops EXIF and GPS).
//   2. openPicker() a drawer: saved pictures, an upload button and "use a link".
//
// The server checks every upload again (type sniffing, size) — nothing here is trusted.
// ==========================================================================
import { toast } from "../../utils.js";
import { esc, openDrawer, closeDrawer, confirmDanger, withBusy } from "../core/ui.js";
import { fitWithin, coverSquare, fmtKB, adminErrorText } from "../../push/push-admin-core.js";
import { S } from "./state.js";
import * as M from "./model.js";

const MAX_FILE = 25 * 1024 * 1024;       // what we will even try to read (a phone photo is ~3–8 MB)
const PICTURE_SIDE = 1024;               // longest side of a notification picture
const ICON_SIDE = 192;                   // icons are square
const THUMB_SIDE = 96;

/* ==========================================================================
   Preparing a file
   ========================================================================== */
async function decode(file) {
  if (!file || !/^image\//i.test(file.type || "") || /svg/i.test(file.type)) throw new Error("not_a_picture");
  if (file.size > MAX_FILE) throw new Error("file_too_big");
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });   // phone photos arrive rotated correctly
      return { src: bmp, w: bmp.width, h: bmp.height, release: () => { try { bmp.close(); } catch { /* ignore */ } } };
    } catch { /* an older browser, or a format only <img> can read: try that */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("not_a_picture");
  }
}

const canvasOf = (w, h) => Object.assign(document.createElement("canvas"), { width: Math.max(1, w), height: Math.max(1, h) });
const whiteFill = (g, w, h) => { g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); };   // JPEG has no transparency
const toBlob = (canvas, type, q) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode_failed"))), type, q));

/** JPEG at the best quality that still fits `maxBytes`. */
async function jpegUnder(canvas, maxBytes, { startQ = 0.88, minQ = 0.45 } = {}) {
  let q = startQ;
  let blob = await toBlob(canvas, "image/jpeg", q);
  while (blob.size > maxBytes && q > minQ) { q = Math.max(minQ, q - 0.08); blob = await toBlob(canvas, "image/jpeg", q); }
  return blob;
}

const toBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1] || "");
  r.onerror = () => rej(new Error("read_failed"));
  r.readAsDataURL(blob);
});

async function pictureBlob(dec, maxBytes) {
  let scale = 1;
  for (let i = 0; i < 6; i++) {
    const side = Math.round(PICTURE_SIDE * scale);
    const f = fitWithin(dec.w, dec.h, side, side);
    const c = canvasOf(f.width, f.height);
    const g = c.getContext("2d");
    whiteFill(g, f.width, f.height);
    g.imageSmoothingQuality = "high";
    g.drawImage(dec.src, 0, 0, f.width, f.height);
    const blob = await jpegUnder(c, maxBytes);
    if (blob.size <= maxBytes) return { blob, mime: "image/jpeg", width: f.width, height: f.height };
    scale *= 0.8;                         // still too heavy at the lowest quality: make it smaller and try again
  }
  throw new Error("picture_too_heavy");
}

async function iconBlob(dec, maxBytes) {
  const { sx, sy, side } = coverSquare(dec.w, dec.h);          // the middle square: an icon is never stretched
  const c = canvasOf(ICON_SIDE, ICON_SIDE);
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(dec.src, sx, sy, side, side, 0, 0, ICON_SIDE, ICON_SIDE);
  const png = await toBlob(c, "image/png");                     // PNG keeps a transparent background
  if (png.size <= maxBytes) return { blob: png, mime: "image/png", width: ICON_SIDE, height: ICON_SIDE };
  const flat = canvasOf(ICON_SIDE, ICON_SIDE);
  const fg = flat.getContext("2d");
  whiteFill(fg, ICON_SIDE, ICON_SIDE);
  fg.drawImage(c, 0, 0);
  return { blob: await jpegUnder(flat, maxBytes), mime: "image/jpeg", width: ICON_SIDE, height: ICON_SIDE };
}

async function thumbBlob(dec, maxBytes, square) {
  let side = THUMB_SIDE;
  for (let i = 0; i < 4; i++) {
    let c;
    if (square) {
      const { sx, sy, side: s } = coverSquare(dec.w, dec.h);
      c = canvasOf(side, side);
      const g = c.getContext("2d");
      whiteFill(g, side, side);
      g.drawImage(dec.src, sx, sy, s, s, 0, 0, side, side);
    } else {
      const f = fitWithin(dec.w, dec.h, side, side);
      c = canvasOf(f.width, f.height);
      const g = c.getContext("2d");
      whiteFill(g, f.width, f.height);
      g.drawImage(dec.src, 0, 0, f.width, f.height);
    }
    const blob = await jpegUnder(c, maxBytes, { startQ: 0.8, minQ: 0.4 });
    if (blob.size <= maxBytes) return blob;
    side = Math.round(side * 0.8);
  }
  throw new Error("picture_too_heavy");
}

/**
 * file → { data, thumb, mime, bytes, width, height } ready for model.uploadImage().
 * kind "icon": middle square, 192 × 192 PNG.   kind "image": longest side 1024, JPEG.
 */
export async function prepare(file, kind, limits = S.limits) {
  const dec = await decode(file);
  try {
    const main = kind === "icon" ? await iconBlob(dec, limits.imageMaxBytes) : await pictureBlob(dec, limits.imageMaxBytes);
    const thumb = await thumbBlob(dec, limits.thumbMaxBytes, kind === "icon");
    return { data: await toBase64(main.blob), thumb: await toBase64(thumb), mime: main.mime, bytes: main.blob.size, width: main.width, height: main.height };
  } finally {
    dec.release();
  }
}

const PREP_TEXT = {
  not_a_picture: "That file is not a picture this browser can read. Use a JPEG, PNG or WebP photo.",
  file_too_big: "That file is too large (over 25 MB). Pick a smaller photo.",
  picture_too_heavy: "This picture is too detailed to shrink under the size limit. Try a simpler picture.",
  encode_failed: "The browser could not prepare this picture. Try another one.",
  read_failed: "The picture could not be read. Try again.",
};
export const prepErrorText = (err) => PREP_TEXT[err && err.message] || adminErrorText(err);

/* ==========================================================================
   The picker
   ========================================================================== */
const HTTPS = /^https:\/\/[^\s/$.?#][^\s]*\.[^\s]{2,}$/i;

const thumbHtml = (img, current) => `
  <div class="pn-thumb${current && current === img.url ? " on" : ""}" data-id="${esc(img.id)}">
    <button type="button" class="pn-thumb-pick" data-pick="${esc(img.id)}" aria-label="Use ${esc(img.name || "this picture")}">
      <span class="pn-thumb-img"><img src="${esc(img.thumb)}" alt="" loading="lazy"></span>
      <span class="pn-thumb-name">${esc(img.name || "Picture")}</span>
      <small>${esc(fmtKB(img.size))}</small>
    </button>
    <button type="button" class="icon-btn danger pn-thumb-del" data-del="${esc(img.id)}" aria-label="Delete ${esc(img.name || "picture")}" title="Delete"><i class="fa-solid fa-trash"></i></button>
  </div>`;

/**
 * Open the picture drawer. `kind` is "image" (the big picture) or "icon". `onPick({ url, thumb, name, id })` is called when the
 * admin chooses one; the drawer then closes.
 */
export function openPicker({ kind, current = "", onPick }) {
  const isIcon = kind === "icon";
  const L = S.limits;
  const d = openDrawer({
    title: isIcon ? "Choose an icon" : "Choose a picture",
    subtitle: isIcon ? "A small square image shown beside the title." : "A wide picture shown under the text (optional).",
    width: 560,
    html: `<div class="pn-pick">
      <div class="note"><i class="fa-solid fa-circle-info"></i> ${isIcon
        ? "Square works best — it is cropped to the middle square and saved as a 192 × 192 PNG."
        : "Wide pictures (about 2 : 1) look best. It is shrunk to at most 1024 px wide and saved as a JPEG under " + esc(fmtKB(L.imageMaxBytes)) + "."}</div>
      <div class="pn-pick-upload">
        <label class="btn btn-primary" for="pnp-file"><i class="fa-solid fa-upload"></i> Upload from this device</label>
        <input type="file" id="pnp-file" class="sr" accept="image/*">
        <span class="pn-pick-msg" id="pnp-msg" role="status" aria-live="polite"></span>
      </div>
      <div class="field">
        <label for="pnp-url">…or use a link to a picture</label>
        <div class="pn-linkrow"><input type="url" id="pnp-url" inputmode="url" placeholder="https://example.com/picture.jpg" autocomplete="off" spellcheck="false"><button type="button" class="btn btn-outline" id="pnp-use">Use link</button></div>
        <span class="form-hint" id="pnp-url-hint">Must start with https:// and be a public picture. Phones download it from that address.</span>
      </div>
      <div>
        <h3 id="pnp-count">Saved pictures</h3>
        <div id="pnp-grid" class="pn-grid" aria-live="polite"><div class="state"><span class="spinner"></span></div></div>
      </div>
    </div>`,
  });
  const root = d.body;
  const $ = (s) => root.querySelector(s);
  const msg = $("#pnp-msg");
  const grid = $("#pnp-grid");
  let list = [];

  const choose = (img) => { closeDrawer(); onPick({ url: img.url, thumb: img.thumb || "", name: img.name || "", id: img.id || "" }); };

  const paint = () => {
    const mine = list.filter((i) => i.kind === (isIcon ? "icon" : "image"));
    $("#pnp-count").textContent = mine.length ? `Saved ${isIcon ? "icons" : "pictures"} (${mine.length})` : `Saved ${isIcon ? "icons" : "pictures"}`;
    grid.innerHTML = mine.length
      ? mine.map((i) => thumbHtml(i, current)).join("")
      : `<p class="muted pn-pick-empty">Nothing saved yet. Upload one and it will be kept here for next time.</p>`;
  };

  const load = async () => {
    grid.innerHTML = `<div class="state"><span class="spinner"></span></div>`;
    try { list = await M.listImages(); paint(); } catch (err) {
      grid.innerHTML = `<div class="note bad"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(adminErrorText(err))} <button type="button" class="link-btn" data-retry>Try again</button></div>`;
    }
  };

  root.addEventListener("click", async (e) => {
    if (e.target.closest("[data-retry]")) { load(); return; }
    const pick = e.target.closest("[data-pick]");
    if (pick) { const img = list.find((i) => i.id === pick.dataset.pick); if (img) choose(img); return; }
    const del = e.target.closest("[data-del]");
    if (del) {
      const img = list.find((i) => i.id === del.dataset.del);
      if (!img) return;
      const ok = await confirmDanger({
        title: "Delete this picture?",
        message: `“${img.name || "Picture"}” will be removed from your saved pictures. Notifications already sent are not affected, but a scheduled notification that uses it will show no picture.`,
        confirmLabel: "Delete picture",
      });
      if (!ok) return;
      try {
        await withBusy(del, () => M.deleteImage(img.id));
        list = list.filter((i) => i.id !== img.id);
        paint();
        toast("Picture deleted", "success");
      } catch (err) { toast(adminErrorText(err), "error"); }
    }
  });

  $("#pnp-file").addEventListener("change", async (e) => {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    input.disabled = true;
    msg.className = "pn-pick-msg";
    msg.innerHTML = `<span class="spinner sm"></span> Preparing…`;
    try {
      const made = await prepare(file, isIcon ? "icon" : "image");
      msg.innerHTML = `<span class="spinner sm"></span> Uploading ${esc(fmtKB(made.bytes))}…`;
      const saved = await M.uploadImage({ kind: isIcon ? "icon" : "image", name: file.name.replace(/\.[^.]+$/, "").slice(0, 60), data: made.data, thumb: made.thumb });
      toast("Picture saved", "success");
      choose(saved);
    } catch (err) {
      msg.className = "pn-pick-msg bad";
      msg.textContent = prepErrorText(err);
    } finally {
      input.disabled = false;
    }
  });

  const useLink = () => {
    const raw = $("#pnp-url").value.trim();
    const hint = $("#pnp-url-hint");
    if (!HTTPS.test(raw) || raw.length > L.imageUrlMax) {
      hint.textContent = "That is not a valid https:// link. Paste the full address of a public picture.";
      hint.className = "form-hint bad";
      return;
    }
    choose({ url: raw, thumb: "", name: "", id: "" });
  };
  $("#pnp-use").addEventListener("click", useLink);
  $("#pnp-url").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); useLink(); } });

  load();
  return d;
}
