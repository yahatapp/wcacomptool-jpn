import { Link } from '@tanstack/react-router'
import { Cuboid, FileCheck2, CircleHelp } from 'lucide-react'
import { Button } from './ui/button'

export default function Header() {
  return <header className="site-header">
    <nav className="page-wrap header-content" aria-label="メインナビゲーション">
      <Link to="/" className="site-brand">
        <span className="brand-icon"><Cuboid size={22} aria-hidden="true" /></span>
        <span>WCA 役割分担ツール</span>
      </Link>
      <div className="header-links">
        <Button asChild variant="ghost">
          <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: 'is-active' }}>役割分担を作成</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link to="/" hash="check-title"><FileCheck2 aria-hidden="true" />CSVチェック</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link to="/about" activeProps={{ className: 'is-active' }}><CircleHelp aria-hidden="true" />使い方・条件</Link>
        </Button>
      </div>
    </nav>
  </header>
}
