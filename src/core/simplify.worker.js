/* 后台读二进制 STL。只有调用方传入小于 1 的 ratio 时才减面。 */
import { isBinarySTL, parseBinarySTL, frameOf, applyFrame, smoothSoupNormals } from './simplify.js';
import { decimate } from './decimate.js';

self.onmessage = (e) => {
  try {
    if (e.data.kind === 'decimate') {
      const src = new Float32Array(e.data.positions);
      const out = decimate(src, {
        mode: e.data.mode,
        ratio: e.data.ratio,
        fidelity: e.data.fidelity,
        onProgress: (p) => self.postMessage({ progress: p }),
      });
      const normals = smoothSoupNormals(out.positions);
      self.postMessage({
        positions: out.positions,
        normals,
        nfIn: out.nfIn,
        nfOut: out.nfOut,
      }, [out.positions.buffer, normals.buffer]);
      return;
    }
    const buf = e.data.buffer;
    if (!isBinarySTL(buf)) {
      self.postMessage({ ascii: true });
      return;
    }
    const full = parseBinarySTL(buf);
    const nfIn = full.length / 9;
    const ratio = e.data.ratio;
    let positions = full;
    let normals = null;
    if (ratio && ratio < 1 && nfIn > 8) {
      const out = decimate(full, { mode: 'ratio', ratio, onProgress: (p) => self.postMessage({ progress: p }) });
      positions = out.positions;
      normals = smoothSoupNormals(positions);
    }
    const frame = frameOf(positions);
    applyFrame(positions, frame);
    const transfer = [positions.buffer];
    if (normals) transfer.push(normals.buffer);
    self.postMessage({
      positions,
      normals,
      nfIn,
      nfOut: positions.length / 9,
    }, transfer);
  } catch (err) {
    self.postMessage({ error: err && err.message ? err.message : String(err) });
  }
};
