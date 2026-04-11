import { useRef, useState } from 'react'

export default function UploadZone({ onSubmit, error }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [selected, setSelected] = useState(null)

  const accept = (file) => {
    if (!file) return
    const name = file.name.toLowerCase()
    if (!name.endsWith('.nii') && !name.endsWith('.nii.gz')) {
      alert('Please select a NIfTI file (.nii or .nii.gz)')
      return
    }
    setSelected(file)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    accept(e.dataTransfer.files[0])
  }

  return (
    <div className="flex flex-col items-center justify-center h-full px-4 relative overflow-hidden">

      {/* ambient glow */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: 700, height: 400,
          top: '-10%', left: '50%', transform: 'translateX(-50%)',
          background: 'radial-gradient(ellipse, rgba(6,182,212,0.07) 0%, transparent 70%)',
          filter: 'blur(40px)',
        }}
      />

      <div className="relative w-full max-w-lg flex flex-col items-center gap-7">

        {/* badge */}
        <div
          className="flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.09)',
            color: 'rgba(255,255,255,0.4)',
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
          VesselBoost · Gemini AI · NiiVue
        </div>

        {/* heading */}
        <div className="text-center space-y-3">
          <h2
            className="text-4xl font-bold tracking-tight"
            style={{
              background: 'linear-gradient(180deg, #ffffff 30%, rgba(255,255,255,0.5) 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            Analyze Your Brain Scan
          </h2>
          <p className="text-sm leading-relaxed max-w-sm mx-auto" style={{ color: 'rgba(255,255,255,0.38)' }}>
            Upload a NIfTI MRI file to automatically segment cerebrovascular
            lesions and receive an AI-powered clinical summary.
          </p>
        </div>

        {/* drop zone */}
        <div
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onClick={() => inputRef.current?.click()}
          className="w-full rounded-2xl cursor-pointer transition-all duration-200 flex flex-col items-center gap-4 py-12 px-8"
          style={{
            background: dragging
              ? 'rgba(6,182,212,0.06)'
              : selected
              ? 'rgba(6,182,212,0.03)'
              : 'rgba(255,255,255,0.02)',
            border: `1.5px dashed ${dragging
              ? 'rgba(6,182,212,0.6)'
              : selected
              ? 'rgba(6,182,212,0.35)'
              : 'rgba(255,255,255,0.09)'}`,
            boxShadow: dragging ? '0 0 48px rgba(6,182,212,0.08) inset' : 'none',
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".nii,.gz,application/gzip,application/octet-stream"
            className="hidden"
            onChange={(e) => accept(e.target.files[0])}
          />

          {selected ? (
            <>
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center"
                style={{ background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.2)' }}
              >
                <svg className="w-7 h-7 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-white">{selected.name}</p>
                <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.35)' }}>
                  {(selected.size / 1024 / 1024).toFixed(1)} MB &middot; Click to change
                </p>
              </div>
            </>
          ) : (
            <>
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                <svg className="w-7 h-7" style={{ color: 'rgba(255,255,255,0.3)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-sm font-medium" style={{ color: 'rgba(255,255,255,0.7)' }}>
                  {dragging ? 'Release to upload' : 'Drag & drop or click to browse'}
                </p>
                <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.25)' }}>.nii or .nii.gz</p>
              </div>
            </>
          )}
        </div>

        {error && (
          <div
            className="w-full px-4 py-3 rounded-xl text-sm"
            style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}
          >
            {error}
          </div>
        )}

        {/* buttons */}
        <div className="flex flex-col gap-2.5 w-full">
          <button
            onClick={() => selected && onSubmit(selected)}
            disabled={!selected}
            className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all duration-150 active:scale-[0.98]"
            style={selected ? {
              background: 'linear-gradient(135deg, #06b6d4, #0891b2)',
              color: '#000',
              boxShadow: '0 4px 20px rgba(6,182,212,0.3)',
            } : {
              background: 'rgba(255,255,255,0.04)',
              color: 'rgba(255,255,255,0.2)',
              border: '1px solid rgba(255,255,255,0.07)',
              cursor: 'not-allowed',
            }}
          >
            Analyze Scan
          </button>

          <button
            onClick={() => onSubmit(null, true)}
            className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2"
            style={{
              background: 'rgba(99,102,241,0.12)',
              border: '1px solid rgba(99,102,241,0.25)',
              color: '#a5b4fc',
            }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Run Demo (1.nii Dataset)
          </button>
        </div>

        {/* feature row */}
        <div className="grid grid-cols-3 gap-3 w-full pt-1">
          {[
            {
              icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21a48.25 48.25 0 01-8.135-.687c-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />,
              label: 'Segmentation', desc: 'VesselBoost U-Net',
            },
            {
              icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />,
              label: 'AI Analysis', desc: 'Powered by Gemini',
            },
            {
              icon: <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />,
              label: '3D Viewer', desc: 'Multi-plane NIfTI',
            },
          ].map(({ label, desc, icon }) => (
            <div
              key={label}
              className="flex flex-col items-center gap-2.5 p-4 rounded-xl"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <svg className="w-5 h-5 text-cyan-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                {icon}
              </svg>
              <div className="text-center">
                <p className="text-xs font-semibold text-white">{label}</p>
                <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.3)' }}>{desc}</p>
              </div>
            </div>
          ))}
        </div>

      </div>
    </div>
  )
}
