import React from 'react';
import { Layout } from '@arco-design/web-react';
import MachineCard from './components/MachineCard.jsx';
import ModelCard from './components/ModelCard.jsx';
import OrientCard from './components/OrientCard.jsx';
import ProtectCard from './components/ProtectCard.jsx';
import SliceCard from './components/SliceCard.jsx';
import SupportCard from './components/SupportCard.jsx';
import ExportCard from './components/ExportCard.jsx';
import Viewport from './components/Viewport.jsx';

const Sider = Layout.Sider;
const Content = Layout.Content;

export default function App() {
  return (
    <Layout style={{ height: '100vh' }}>
      <Sider width={344} className="panel">
        <div className="brand"><h1>ResinForge</h1><span className="ver">语义支撑系统 v0.1 · 算法验证版</span></div>
        <div className="sub">浏览器端光固化支撑管线：像素级切片 → 多目标朝向优化 → 孤岛检测 → 支撑生成 → STL 导出。推荐从「环面结」开始体验。</div>
        <MachineCard />
        <ModelCard />
        <OrientCard />
        <ProtectCard />
        <SliceCard />
        <SupportCard />
        <ExportCard />
      </Sider>
      <Content className="viewport-wrap">
        <Viewport />
      </Content>
    </Layout>
  );
}
