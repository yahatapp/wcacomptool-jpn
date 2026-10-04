import { Link } from '@tanstack/react-router'
import ThemeToggle from './ThemeToggle'

export default function Header() {
  return <header className="border-b border-[var(--line)] bg-[var(--header-bg)] px-4">
    <nav className="page-wrap flex flex-wrap items-center gap-6 py-4" aria-label="メインナビゲーション">
      <Link to="/" className="font-semibold text-[var(--sea-ink)] no-underline">WCA 役割分担ツール</Link>
      <Link to="/about" className="nav-link">使い方・割り当て条件</Link>
      <div className="ml-auto"><ThemeToggle /></div>
    </nav>
  </header>
}
