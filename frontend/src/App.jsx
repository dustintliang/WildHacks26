import { useState } from 'react'
import Header from './components/Header'
import UploadZone from './components/UploadZone'
import NiftiViewer from './components/NiftiViewer'
import AnalysisPanel from './components/AnalysisPanel'

const API_BASE = 'http://127.0.0.1:8000'

export default function App() {
  const [phase, setPhase] = useState('upload')
  const [originalFile, setOriginalFile] = useState(null)
  const [maskedBlob, setMaskedBlob] = useState(null)
  const [analysis, setAnalysis] = useState('')
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState({ step: 0, total: 8, action: 'Starting...' })
  const [segments, setSegments] = useState({})
  const [riskScores, setRiskScores] = useState({})
  const [narrativeSummary, setNarrativeSummary] = useState('')

  const handleSubmit = async (file, isDemo = false) => {
    setError(null)
    setOriginalFile(file)
    setMaskedBlob(null)
    setAnalysis('')
    setSegments({})
    setRiskScores({})
    setNarrativeSummary('')
    setProgress({ step: 0, total: 8, action: 'Connecting to server...' })
    setPhase('processing')

    try {
      if (isDemo) {
        // ── Demo mode: load results from local fixture files ──────────────
        const STEP_LABELS = [
          'Preprocessing', 'Vessel Segmentation', 'Artery Labeling',
          'Centerline Extraction', 'Feature Analysis', 'Slice Rendering',
          'AI Report', 'Risk Scoring',
        ]
        for (let i = 0; i < STEP_LABELS.length; i++) {
          setProgress({ step: i + 1, total: 8, action: STEP_LABELS[i] })
          await new Promise(r => setTimeout(r, 1250))
        }

        const [analysisRes, renderRes, demoNiftiRes] = await Promise.all([
          fetch('/fixtures/analyze_response.json'),
          fetch('/fixtures/render_response.json'),
          fetch('/fixtures/demo.nii.gz'),
        ])
        const analysisData = await analysisRes.json()
        const renderData = await renderRes.json()

        // Load demo NIfTI so the viewer shows the brain scan
        if (demoNiftiRes.ok) {
          const blob = await demoNiftiRes.blob()
          setOriginalFile(new File([blob], 'demo.nii.gz', { type: 'application/gzip' }))
        }

        setSegments(analysisData.binary_segments ?? {})
        setRiskScores(analysisData.risk_scores ?? {})
        setNarrativeSummary(analysisData.narrative_summary ?? '')
        setAnalysis(analysisData.narrative_summary ?? '')

        // Try to load overlay from backend if it's running (optional)
        if (renderData.overlay_url) {
          try {
            const overlayRes = await fetch(`${API_BASE}${renderData.overlay_url}`)
            if (overlayRes.ok) setMaskedBlob(await overlayRes.blob())
          } catch { /* overlay is optional */ }
        }

        setProgress({ step: 8, total: 8, action: 'Analysis complete!' })
        setPhase('results')
        return
      }

      // ── Real upload: call backend ─────────────────────────────────────
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch(`${API_BASE}/analyze`, { method: 'POST', body: formData })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `Server returned ${res.status}`)
      }

      const initialData = await res.json()
      const jobId = initialData.job_id

      // Poll until complete, updating progress bar on every tick
      let data
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        const pollRes = await fetch(`${API_BASE}/results/${jobId}`)
        if (!pollRes.ok) throw new Error(`Polling failed: ${pollRes.status}`)
        data = await pollRes.json()

        if (data.status === 'processing' && data.progress) {
          setProgress(data.progress)
        }

        if (data.status === 'complete' || data.status === 'failed') break
      }

      if (data.status === 'failed') {
        throw new Error(data.message || 'Pipeline failed during processing')
      }

      setProgress({ step: 8, total: 8, action: 'Analysis complete!' })

      setSegments(data.binary_segments ?? {})
      setRiskScores(data.risk_scores ?? {})
      setNarrativeSummary(data.narrative_summary ?? '')
      setAnalysis(data.narrative_summary ?? '')

      // Fetch severity-coded overlay NIfTI from /render/{job_id} for NiiVue
      try {
        const renderRes = await fetch(`${API_BASE}/render/${jobId}`)
        if (renderRes.ok) {
          const renderData = await renderRes.json()
          if (renderData.overlay_url) {
            const r = await fetch(`${API_BASE}${renderData.overlay_url}`)
            if (r.ok) setMaskedBlob(await r.blob())
          }
        }
      } catch (e) {
        console.warn('Overlay load failed:', e)
      }
      setPhase('results')
    } catch (e) {
      console.error(e)
      setError(e.message)
      setPhase('upload')
    }
  }

  const reset = () => {
    setPhase('upload')
    setOriginalFile(null)
    setMaskedBlob(null)
    setAnalysis('')
    setSegments({})
    setRiskScores({})
    setNarrativeSummary('')
    setError(null)
    setProgress({ step: 0, total: 8, action: 'Starting...' })
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      <Header />

      <main className="flex-1 overflow-hidden">
        {phase === 'upload' && (
          <UploadZone onSubmit={handleSubmit} error={error} />
        )}

        {(phase === 'processing' || phase === 'results') && (
          <div className="flex h-full">
            <div className="flex-[3] min-w-0">
              <NiftiViewer originalFile={originalFile} maskedBlob={maskedBlob} />
            </div>

            <div className="flex-[2] min-w-0 border-l border-gray-800 overflow-y-auto">
              {phase === 'processing' ? (
                <ProcessingPanel progress={progress} />
              ) : (
                <AnalysisPanel 
                  segments={segments}
                  riskScores={riskScores}
                  narrativeSummary={narrativeSummary}
                  onReset={reset} 
                />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function ProcessingPanel({ progress }) {
  const { step, total, action } = progress
  const pct = total > 0 ? Math.round((step / total) * 100) : 0

  const STEP_LABELS = [
    'Preprocessing',
    'Vessel Segmentation',
    'Artery Labeling',
    'Centerline Extraction',
    'Feature Analysis',
    'Slice Rendering',
    'AI Report',
    'Risk Scoring',
  ]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-800 shrink-0">
        <h2 className="text-sm font-semibold text-white">Analyzing Scan</h2>
        <p className="text-xs text-gray-500 mt-0.5">Cerebrovascular pipeline running...</p>
      </div>

      {/* Progress section */}
      <div className="flex-1 px-5 py-6 flex flex-col gap-6">

        {/* Big percentage display */}
        <div className="text-center">
          <span className="text-5xl font-bold tabular-nums" style={{
            background: 'linear-gradient(90deg, #22d3ee, #818cf8)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>
            {pct}%
          </span>
          <p className="text-xs text-gray-400 mt-2 min-h-[1.25rem] transition-all duration-500">
            {action}
          </p>
        </div>

        {/* Progress bar track */}
        <div className="relative h-3 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
            style={{
              width: `${pct}%`,
              background: 'linear-gradient(90deg, #06b6d4, #6366f1)',
              boxShadow: '0 0 12px rgba(99, 102, 241, 0.6)',
            }}
          />
          {/* Animated shimmer overlay */}
          <div
            className="absolute inset-y-0 left-0 rounded-full pointer-events-none"
            style={{
              width: `${pct}%`,
              background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.18) 50%, transparent 100%)',
              animation: 'shimmer 1.8s infinite',
            }}
          />
        </div>

        {/* 8-step grid */}
        <div className="grid grid-cols-4 gap-1.5">
          {STEP_LABELS.map((label, i) => {
            const stepNum = i + 1
            const isDone = stepNum < step
            const isActive = stepNum === step
            return (
              <div
                key={label}
                className={`flex flex-col items-center gap-1 p-2 rounded-lg transition-all duration-300 ${
                  isActive ? 'bg-indigo-950/50 border border-indigo-700/50' :
                  isDone   ? 'bg-gray-900/50 border border-gray-700/30' :
                             'border border-transparent'
                }`}
              >
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-300 ${
                  isDone   ? 'bg-cyan-500 text-black' :
                  isActive ? 'border-2 border-indigo-400 text-indigo-400 animate-pulse' :
                             'border-2 border-gray-700 text-gray-700'
                }`}>
                  {isDone ? '✓' : stepNum}
                </div>
                <span className={`text-[9px] text-center leading-tight transition-colors duration-300 ${
                  isActive ? 'text-indigo-300' : isDone ? 'text-gray-500' : 'text-gray-700'
                }`}>
                  {label}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-gray-800 shrink-0">
        <p className="text-xs text-gray-600 leading-relaxed">
          CPU mode: ~4–5 min. The NIfTI viewer renders the original scan while the model runs.
        </p>
      </div>

      <style>{`
        @keyframes shimmer {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  )
}
