import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@arco-design/web-react';
import Card from './Card.jsx';
import { bus } from '../store.js';
import { loadDemo, loadSTLBuffers, setActivePart } from '../core/model.js';

/* 模型：载入 STL / OBJ / 3MF + 4 个内置 demo + modelInfo（订阅 bus 'modelInfo'） */
export default function ModelCard() {
  const fileRef = useRef(null);
  const addRef = useRef(null);
  const [info, setInfo] = useState(null);
  useEffect(() => bus.on('modelInfo', setInfo), []);
  return (
    <Card step={1} title="模型">
      <div className="row">
        <Button onClick={() => fileRef.current && fileRef.current.click()}>载入模型</Button>
        <Button onClick={() => addRef.current && addRef.current.click()}>追加模型</Button>
        <input
          type="file" accept=".stl,.obj,.3mf" multiple style={{ display: 'none' }} ref={fileRef}
          onChange={e => {
            const files = [...e.target.files];
            Promise.all(files.map(async f => ({ buf: await f.arrayBuffer(), name: f.name })))
              .then(items => items.length && loadSTLBuffers(items, { append: false }));
            e.target.value = '';
          }}
        />
        <input
          type="file" accept=".stl,.obj,.3mf" multiple style={{ display: 'none' }} ref={addRef}
          onChange={e => {
            const files = [...e.target.files];
            Promise.all(files.map(async f => ({ buf: await f.arrayBuffer(), name: f.name })))
              .then(items => items.length && loadSTLBuffers(items, { append: true }));
            e.target.value = '';
          }}
        />
      </div>
      <div className="row">
        <Button onClick={() => loadDemo('knot')}>环面结</Button>
        <Button onClick={() => loadDemo('mushroom')}>蘑菇</Button>
        <Button onClick={() => loadDemo('tier')}>双层平台</Button>
        <Button onClick={() => loadDemo('statue')}>悬臂雕像</Button>
      </div>
      {info ? (
        <div className="kvbox">
          <div className="kv"><span>文件</span><b>{info.name}</b></div>
          <div className="kv"><span>尺寸</span><b>{info.sizeText}</b></div>
          <div className="kv"><span>三角形</span><b>{info.nf.toLocaleString()}{info.nfFull > info.nf ? `（原 ${info.nfFull.toLocaleString()}）` : ''}</b></div>
        </div>
      ) : (
        <div className="hint">未载入模型</div>
      )}
      {info ? <div className="hint">选中一个模型，右键选「放大缩小」，在视口左侧调整大小和比例。</div> : null}
      {info && info.parts && info.parts.length > 1 ? (
        <div className="kvbox">
          {info.parts.map(p => (
            <div className="kv" key={p.id}>
              <span>{p.name}</span>
              <b style={{ cursor: 'pointer' }} onClick={() => setActivePart(p.id)}>跳转</b>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
