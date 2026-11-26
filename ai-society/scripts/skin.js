// スキン画像 (PNG) が「スリム(腕3ピクセル)」か「クラシック(腕4ピクセル)」かを画像から見分ける。
// スリムのスキンは右腕の背中側 (x=54〜55, y=20〜31) が透明になっている
import fs from 'node:fs'
import zlib from 'node:zlib'

export function decodePng (buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNGではない')
  let off = 8; let w = 0; let h = 0; let depth = 0; let type = 0; let palette = null; let trns = null
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const kind = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; if (data[12]) throw new Error('インターレースPNGは未対応') }
    if (kind === 'PLTE') palette = data
    if (kind === 'tRNS') trns = data
    if (kind === 'IDAT') idat.push(data)
    if (kind === 'IEND') break
    off += 12 + len
  }
  if (depth !== 8) throw new Error(`色深度${depth}は未対応`)
  const ch = { 6: 4, 2: 3, 3: 1, 4: 2, 0: 1 }[type]
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0; const b = y ? px[(y - 1) * stride + x] : 0; const c = x >= ch && y ? px[(y - 1) * stride + x - ch] : 0
      let v = line[x]
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      px[y * stride + x] = v & 255
    }
  }
  const alpha = (x, y) => {
    const i = y * stride + x * ch
    if (type === 6) return px[i + 3]
    if (type === 4) return px[i + 1]
    if (type === 3) return trns && px[i] < trns.length ? trns[px[i]] : 255
    return 255
  }
  return { width: w, height: h, alpha }
}

export function skinVariant (file) {
  try {
    const img = decodePng(fs.readFileSync(file))
    if (img.height < 64) return 'classic' // 古い 64x32 形式はクラシックだけ
    return img.alpha(54, 20) === 0 && img.alpha(55, 20) === 0 ? 'slim' : 'classic'
  } catch { return 'classic' }
}
