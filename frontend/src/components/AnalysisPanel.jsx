import { useState } from 'react'

export default function AnalysisPanel({ segments, riskScores, narrativeSummary, onReset }) {
  const [tab, setTab] = useState('summary')

  const arteryEntries = Object.entries(segments)
  const visibleCount = arteryEntries.filter(([, a]) => a.visible).length

  const tabs = [
    { id: 'summary', label: 'Summary' },
    { id: 'vessels', label: `Vessels (${visibleCount}/${arteryEntries.length})` },
    { id: 'risk',    label: 'Risk' },
  ]

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-4 border-b border-gray-800 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold">Analysis Results</h2>
            <p className="text-xs text-gray-500 mt-0.5">Cerebrovascular Pipeline</p>
          </div>
          <button
            onClick={onReset}
            className="px-3 py-1.5 text-xs rounded-lg bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
          >
            New scan
          </button>
        </div>
        <div className="flex gap-1">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors border ${
                tab === t.id
                  ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'
                  : 'text-gray-500 hover:text-gray-300 border-transparent'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {tab === 'summary' && <SummaryTab text={narrativeSummary} segments={segments} riskScores={riskScores} />}
        {tab === 'vessels' && <VesselsTab arteryEntries={arteryEntries} />}
        {tab === 'risk'    && <RiskTab riskScores={riskScores} />}
      </div>

      <div className="px-5 py-3 border-t border-gray-800 shrink-0">
        <p className="text-xs text-gray-600 leading-relaxed">
          For research purposes only. Always consult a qualified neuroradiologist for clinical interpretation.
        </p>
      </div>
    </div>
  )
}

// ─── Summary Tab ──────────────────────────────────────────────────────────────

function SummaryTab({ text, segments, riskScores }) {
  // If narrative summary is a fallback/error message, show a generated one instead
  const isFallback = !text || text.toLowerCase().includes('not generated') || text.toLowerCase().includes('api key')

  const arteryEntries = Object.entries(segments)
  const visibleArteries = arteryEntries.filter(([, a]) => a.visible)

  // Collect all findings for the auto-generated summary
  const allFindings = visibleArteries.flatMap(([name, a]) => {
    const results = []
    const stenoses = a.findings?.stenosis ?? []
    const aneurysms = a.findings?.aneurysms ?? []
    const tortuosity = a.findings?.tortuosity

    stenoses.forEach(s => results.push({ type: 'stenosis', artery: name, ...s }))
    aneurysms.forEach(an => results.push({ type: 'aneurysm', artery: name, ...an }))
    if (tortuosity?.flagged) results.push({ type: 'tortuosity', artery: name, ...tortuosity })
    return results
  })

  const highRisks = Object.entries(riskScores).filter(([, r]) => r.severity === 'high')

  return (
    <div className="space-y-4">
      {/* Narrative from backend */}
      {!isFallback ? (
        parseMarkdown(text).length > 0
          ? parseMarkdown(text).map((s, i) => <NarrativeSection key={i} {...s} />)
          : <PlainText text={text} />
      ) : (
        /* Auto-generated summary when API key not configured */
        <>
          {highRisks.length > 0 && (
            <div className="rounded-xl border border-red-900/50 bg-red-950/20 px-4 py-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-2">High Risk Findings</h3>
              <ul className="space-y-1.5">
                {highRisks.map(([key, r]) => (
                  <li key={key} className="text-sm text-gray-200 leading-relaxed">
                    <span className="text-red-400 font-medium">{key.replace(/_/g, ' ')}</span>
                    {' '}— score {Math.round(r.score)}/100
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-xl border border-gray-700 bg-gray-900/50 px-4 py-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Vessels Analyzed</h3>
            <p className="text-sm text-gray-200 leading-relaxed">
              {visibleArteries.length} of {arteryEntries.length} vessels visible.
              {' '}{visibleArteries.map(([n]) => n.replace(/_/g, ' ')).join(', ')}.
            </p>
          </div>

          {allFindings.length > 0 ? (
            <div className="rounded-xl border border-yellow-900/50 bg-yellow-950/20 px-4 py-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-yellow-400 mb-2">Detected Findings</h3>
              <ul className="space-y-1.5">
                {allFindings.map((f, i) => (
                  <li key={i} className="text-sm text-gray-300 leading-relaxed">
                    {f.type === 'stenosis' && (
                      <><span className="text-yellow-400 font-medium">{f.artery.replace(/_/g, ' ')}</span>: stenosis {f.stenosis_percent?.toFixed(1)}% ({f.severity})</>
                    )}
                    {f.type === 'aneurysm' && (
                      <><span className="text-orange-400 font-medium">{f.artery.replace(/_/g, ' ')}</span>: aneurysm candidate — size ratio {f.size_ratio?.toFixed(2)}, aspect {f.aspect_ratio?.toFixed(2)}, confidence {f.confidence ?? 'unknown'}</>
                    )}
                    {f.type === 'tortuosity' && (
                      <><span className="text-cyan-400 font-medium">{f.artery.replace(/_/g, ' ')}</span>: elevated tortuosity (DF={f.distance_factor?.toFixed(2)})</>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3">
              <p className="text-sm text-gray-400">No significant findings detected in visible vessels.</p>
            </div>
          )}

          <div className="rounded-xl border border-gray-800 bg-gray-900/30 px-3 py-2.5">
            <p className="text-xs text-gray-600 italic">
              Narrative AI summary unavailable — configure a Gemini API key for full reports.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

function NarrativeSection({ title, content }) {
  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900/50 px-4 py-3">
      {title && <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">{title}</h3>}
      <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">{content}</p>
    </div>
  )
}

function PlainText({ text }) {
  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900/50 px-4 py-3">
      <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
        {text || 'No narrative summary generated.'}
      </p>
    </div>
  )
}

// ─── Vessels Tab ──────────────────────────────────────────────────────────────

function VesselsTab({ arteryEntries }) {
  const [open, setOpen] = useState(null)

  if (arteryEntries.length === 0) return <Empty text="No artery data available." />

  const withFindings = arteryEntries.filter(([, a]) =>
    a.visible && (
      a.findings?.stenosis?.length > 0 ||
      a.findings?.aneurysms?.length > 0 ||
      a.findings?.tortuosity?.flagged
    )
  )

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2.5">Circle of Willis</h3>
        <div className="grid grid-cols-2 gap-1.5">
          {arteryEntries.map(([name, artery]) => (
            <div
              key={name}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium ${
                artery.visible
                  ? 'bg-green-950/30 border border-green-900/60 text-green-400'
                  : 'bg-gray-900/40 border border-gray-800 text-gray-600'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${artery.visible ? 'bg-green-400' : 'bg-gray-700'}`} />
              <span className="truncate">{name.replace(/_/g, ' ')}</span>
              {artery.visible && artery.voxel_count > 0 && (
                <span className="ml-auto text-gray-500 font-normal">{artery.voxel_count.toLocaleString()} vx</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {withFindings.length > 0 ? (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2.5">Findings</h3>
          <div className="space-y-2">
            {withFindings.map(([name, artery]) => (
              <ArteryAccordion
                key={name}
                name={name}
                artery={artery}
                isOpen={open === name}
                onToggle={() => setOpen(open === name ? null : name)}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3">
          <p className="text-xs text-gray-500">No significant findings detected in visible vessels.</p>
        </div>
      )}
    </div>
  )
}

function ArteryAccordion({ name, artery, isOpen, onToggle }) {
  const { findings = {}, analysis = '', mean_radius_mm, segment_length_mm } = artery
  const { stenosis = [], aneurysms = [], tortuosity } = findings

  return (
    <div className="rounded-xl border border-gray-700 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-900 hover:bg-gray-800 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-semibold text-white shrink-0">{name.replace(/_/g, ' ')}</span>
          <div className="flex gap-1.5 flex-wrap">
            {stenosis.length > 0 && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-900/50 text-yellow-400">
                {stenosis.length} stenosis
              </span>
            )}
            {aneurysms.length > 0 && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-900/50 text-orange-400">
                {aneurysms.length} aneurysm
              </span>
            )}
            {tortuosity?.flagged && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-cyan-900/50 text-cyan-400">tortuous</span>
            )}
          </div>
        </div>
        <svg
          className={`w-4 h-4 text-gray-500 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="px-4 py-3 bg-gray-900/50 space-y-3 border-t border-gray-800">

          {/* Vessel metrics row */}
          {(mean_radius_mm != null || segment_length_mm != null) && (
            <div className="flex gap-4 flex-wrap">
              {mean_radius_mm != null && mean_radius_mm > 0 && (
                <p className="text-xs text-gray-500">
                  Mean radius: <span className="text-gray-300 font-medium">{mean_radius_mm.toFixed(2)} mm</span>
                </p>
              )}
              {segment_length_mm != null && segment_length_mm > 0 && (
                <p className="text-xs text-gray-500">
                  Length: <span className="text-gray-300 font-medium">{segment_length_mm.toFixed(1)} mm</span>
                </p>
              )}
            </div>
          )}

          {stenosis.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-yellow-400 mb-2">Stenosis</p>
              <div className="space-y-2">
                {stenosis.map((s, i) => (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center gap-2.5">
                      <div className="flex-1 h-1.5 bg-gray-800 rounded-full">
                        <div
                          className={`h-1.5 rounded-full ${
                            s.stenosis_percent >= 70 ? 'bg-red-500' :
                            s.stenosis_percent >= 50 ? 'bg-orange-500' : 'bg-yellow-500'
                          }`}
                          style={{ width: `${Math.min(100, s.stenosis_percent ?? 0)}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-200 font-medium w-10 text-right">
                        {(s.stenosis_percent ?? 0).toFixed(1)}%
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        s.severity === 'severe'   ? 'bg-red-900/50 text-red-400' :
                        s.severity === 'moderate' ? 'bg-orange-900/50 text-orange-400' :
                                                    'bg-gray-800 text-gray-400'
                      }`}>
                        {s.severity}
                      </span>
                    </div>
                    {s.r_min_mm != null && (
                      <p className="text-xs text-gray-500">
                        r_min {s.r_min_mm.toFixed(2)} mm · r_ref {(s.r_reference_mm ?? 0).toFixed(2)} mm
                        {s.affected_segment_length_mm != null && ` · ${s.affected_segment_length_mm.toFixed(1)} mm segment`}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {aneurysms.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-orange-400 mb-2">Aneurysm Candidates</p>
              <div className="space-y-3">
                {aneurysms.map((a, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="flex gap-4 flex-wrap text-xs text-gray-400">
                      {a.size_ratio   != null && <span>Size ratio <span className="text-gray-200">{a.size_ratio.toFixed(2)}</span></span>}
                      {a.aspect_ratio != null && <span>Aspect <span className="text-gray-200">{a.aspect_ratio.toFixed(2)}</span></span>}
                      {a.deviation_score != null && <span>Dev. score <span className="text-gray-200">{a.deviation_score.toFixed(2)}</span></span>}
                      {a.confidence   != null && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          a.confidence === 'high'     ? 'bg-red-900/50 text-red-400' :
                          a.confidence === 'moderate' ? 'bg-orange-900/50 text-orange-400' :
                                                        'bg-gray-800 text-gray-400'
                        }`}>
                          {a.confidence} confidence
                        </span>
                      )}
                    </div>
                    {/* MNI coordinates */}
                    {a.mni_coords?.length === 3 && (
                      <p className="text-[10px] text-gray-600 font-mono">
                        MNI [{a.mni_coords.map(v => v.toFixed(1)).join(', ')}]
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tortuosity?.flagged && (
            <div>
              <p className="text-xs font-semibold text-cyan-400 mb-1">Tortuosity Flagged</p>
              <div className="flex gap-4 text-xs text-gray-400">
                {tortuosity.distance_factor != null && (
                  <span>Distance factor <span className="text-gray-200">{tortuosity.distance_factor.toFixed(3)}</span></span>
                )}
                {tortuosity.soam != null && (
                  <span>SoAM <span className="text-gray-200">{tortuosity.soam.toFixed(3)}</span></span>
                )}
              </div>
            </div>
          )}

          {analysis && (
            <div className="pt-2 border-t border-gray-800">
              <p className="text-xs text-gray-400 leading-relaxed">{analysis}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Risk Tab ─────────────────────────────────────────────────────────────────

function RiskTab({ riskScores }) {
  const entries = Object.entries(riskScores)
  if (entries.length === 0) return <Empty text="No risk scores available." />

  // Sort: high → moderate → low
  const order = { high: 0, moderate: 1, low: 2 }
  const sorted = [...entries].sort(
    ([, a], [, b]) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
  )

  return (
    <div className="space-y-4">
      {sorted.map(([key, rs]) => <RiskCard key={key} name={key} data={rs} />)}
    </div>
  )
}

function RiskCard({ name, data }) {
  const score    = data?.score    ?? 0
  const severity = (data?.severity ?? 'low').toLowerCase()
  const drivers  = data?.drivers  ?? []
  const label    = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

  const cfg = {
    low:      { text: 'text-green-400',  bar: 'bg-green-500',  border: 'border-green-900/50',  bg: 'bg-green-950/20'  },
    moderate: { text: 'text-yellow-400', bar: 'bg-yellow-500', border: 'border-yellow-900/50', bg: 'bg-yellow-950/20' },
    high:     { text: 'text-red-400',    bar: 'bg-red-500',    border: 'border-red-900/50',    bg: 'bg-red-950/20'    },
  }[severity] ?? { text: 'text-gray-400', bar: 'bg-gray-500', border: 'border-gray-700', bg: 'bg-gray-900/50' }

  return (
    <div className={`rounded-xl border px-4 py-3.5 ${cfg.border} ${cfg.bg}`}>
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-sm font-semibold text-white">{label}</span>
        <div className="flex items-baseline gap-1 ml-2 shrink-0">
          <span className={`text-xl font-bold ${cfg.text}`}>{Math.round(score)}</span>
          <span className="text-xs text-gray-500">/100</span>
        </div>
      </div>
      <div className="w-full h-1.5 bg-gray-800 rounded-full mb-2">
        <div
          className={`h-1.5 rounded-full ${cfg.bar} transition-all`}
          style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
        />
      </div>
      <span className={`text-xs font-medium uppercase tracking-wider ${cfg.text}`}>{severity} risk</span>
      {drivers.length > 0 && (
        <ul className="space-y-1.5 mt-2 pt-2 border-t border-white/5">
          {drivers.map((d, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-gray-400 leading-snug">
              <span className={`mt-1 w-1.5 h-1.5 rounded-full ${cfg.bar} shrink-0`} />
              {d}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Shared ───────────────────────────────────────────────────────────────────

function Empty({ text }) {
  return (
    <div className="flex items-center justify-center h-32">
      <p className="text-sm text-gray-600">{text}</p>
    </div>
  )
}

function parseMarkdown(text) {
  if (!text) return []
  const pattern = /(?:^|\n)(?:#{1,3}\s+|\*\*|)([A-Z][^*\n]{2,40})(?:\*\*)?:?\s*\n/g
  const matches = [...text.matchAll(pattern)]
  if (matches.length < 2) return []
  return matches.map((m, i) => {
    const start = m.index + m[0].length
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    return { title: m[1].trim(), content: text.slice(start, end).trim() }
  }).filter(s => s.content)
}
