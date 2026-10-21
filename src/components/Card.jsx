import React from 'react';

/* 旧 UI 的 .card 区块（深色卡片 + 可选步骤序号） */
export default function Card({ step, title, children }) {
  return (
    <div className="card">
      <h3>{step != null && <span className="step">{step}</span>}{title}</h3>
      {children}
    </div>
  );
}
