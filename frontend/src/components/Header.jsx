export default function Header() {
  return (
    <header
      className="flex items-center gap-3 px-6 py-4 shrink-0 border-b"
      style={{
        background: 'rgba(2,8,16,0.8)',
        backdropFilter: 'blur(16px)',
        borderColor: 'rgba(255,255,255,0.07)',
      }}
    >
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center"
        style={{ background: 'linear-gradient(135deg, #06b6d4 0%, #0369a1 100%)', boxShadow: '0 0 16px rgba(6,182,212,0.35)' }}
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4 fill-white">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" />
        </svg>
      </div>

      <div>
        <h1 className="text-sm font-semibold text-white tracking-wide">CerebralVision</h1>
        <p className="text-xs" style={{ color: 'rgba(255,255,255,0.35)' }}>Cerebrovascular Disease Analysis</p>
      </div>

      <div className="ml-auto flex items-center gap-4">
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium"
          style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#4ade80' }}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          Model ready
        </div>
      </div>
    </header>
  )
}
