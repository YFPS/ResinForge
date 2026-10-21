import React, { useState } from 'react';
import { Input } from '@/components/arc/input/input';
import { PasswordField } from '@/components/arc/password-field/password-field';
import { Button } from '@/components/arc/button/button';
import { Checkbox } from '@/components/arc/checkbox/checkbox';
import './login.css';

export default function LoginApp() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setEmailError(''); setPasswordError('');
    let ok = true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setEmailError('请输入有效的邮箱地址'); ok = false; }
    if (password.length < 6) { setPasswordError('密码至少 6 位'); ok = false; }
    if (!ok) return;
    setLoading(true);
    await new Promise((r) => setTimeout(r, 900));
    setLoading(false);
    if (email.trim() === 'admin@demo.com' && password === '123456') {
      setDone(true);
    } else {
      setPasswordError('账号或密码错误（demo: admin@demo.com / 123456）');
    }
  }

  return (
    <div className="login-shell">
      <aside className="login-left">
        <div className="login-left-glow login-glow-a" />
        <div className="login-left-glow login-glow-b" />
        <div className="login-left-content">
          <div className="login-brand">
            <div className="login-logo">R</div>
            <div>
              <div className="login-brand-name">ResinForge</div>
              <div className="login-brand-sub">光固化自动支撑 · 控制台</div>
            </div>
          </div>

          <div className="login-left-hero">
            <h1 className="login-left-title">
              {done ? '登录成功' : '让每一件打印，\n都稳定高效'}
            </h1>
            <p className="login-left-desc">
              在浏览器内完成模型分析、支撑生成与导出，专注设计，其余交给我们。
            </p>
            <ul className="login-bullets">
              <li>像素级切片与孤岛检测</li>
              <li>e-Stage 风格支撑塔自动生成</li>
              <li>连接底板与自动底板双档</li>
            </ul>
          </div>

          <div className="login-left-foot">
            © 2026 ResinForge · 全部计算在本地浏览器完成
          </div>
        </div>
      </aside>

      <main className="login-right">
        <div className="login-card">
          <h2 className="login-title">{done ? '登录成功' : '欢迎回来'}</h2>
          <p className="login-desc">
            {done ? '正在进入控制台…' : '登录以继续使用你的打印工程'}
          </p>

          {!done && (
            <form onSubmit={handleSubmit} className="login-form">
              <Input
                label="邮箱"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                error={emailError || undefined}
                autoComplete="username"
              />
              <PasswordField
                label="密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                messages={{ showPassword: '显示密码', hidePassword: '隐藏密码' }}
              />
              {passwordError && <p className="login-error">{passwordError}</p>}
              <div className="login-row">
                <Checkbox label="记住我" checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
                <a className="login-link" href="#">忘记密码？</a>
              </div>
              <Button type="submit" variant="primary" size="lg" loading={loading} style={{ width: '100%' }}>
                {loading ? '登录中…' : '登 录'}
              </Button>
            </form>
          )}

          <div className="login-divider"><span>或使用第三方账号</span></div>
          <div className="login-socials">
            <Button variant="secondary" size="md" onClick={() => alert('演示按钮：Google')}>Google</Button>
            <Button variant="secondary" size="md" onClick={() => alert('演示按钮：GitHub')}>GitHub</Button>
          </div>

          <p className="login-foot">
            还没有账号？<a className="login-link" href="#">立即注册</a>
          </p>
        </div>
      </main>
    </div>
  );
}
