import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@arco-design/web-react';
import Card from './Card.jsx';
import { bus } from '../store.js';
import { loadDemo, loadSTLBuffer } from '../core/model.js';

/* 模型：载入 STL + 4 个内置 demo + modelInfo（订阅 bus 'modelInfo'） */
export default function ModelCard() {
  const fileRef = useRef(null);
  const [info, setInfo] = useState(null);
  useEffect(() => bus.on('modelInfo', setInfo), []);
  return (
    <Card step={1} title="模型">
      <div className="row">
        <Button onClick={() => fileRef.current && fileRef.current.click()}>载入 STL</Button>
        <input
          type="file" accept=".stl" style={{ display: 'none' }} ref={fileRef}
          onChange={e => {
            const f = e.target.files[0]; if (!f) return;
            f.arrayBuffer().then(b => loadSTLBuffer(b, f.name));
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
          <div className="kv"><span>三角形</span><b>{info.nf.toLocaleString()}</b></div>
        </div>
      ) : (
        <div className="hint">未载入模型</div>
      )}
    </Card>
  );
}
