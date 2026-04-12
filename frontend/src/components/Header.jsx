export default function Header() {
  return (
    <header className="flex items-center gap-3 px-6 py-3 bg-gray-900 border-b border-gray-800 shrink-0">
      <div className="w-8 h-8 rounded-lg bg-cyan-500 flex items-center justify-center">
        <svg viewBox="0 0 24 24" className="w-5 h-5 text-black fill-current">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" />
        </svg>
      </div>
      <div>
        <h1 className="text-sm font-semibold tracking-wide">CerebralVision</h1>
        <p className="text-xs text-gray-500">Cerebrovascular Disease Analysis</p>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
        <span className="text-xs text-gray-400">Model ready</span>
      </div>
    </header>
  )
}
