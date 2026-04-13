import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { ARTERY_META } from './NiftiViewer'

/**
 * FindingsViewer — 3D vessel view with highlighted finding regions.
 *
 * Renders the full vessel point cloud (same data as Vessel3DViewer)
 * but dims non-finding arteries and adds glowing markers/highlights
 * for each finding (stenosis, aneurysm, tortuosity) that the user
 * can click in a sidebar to fly the camera to.
 */

const FINDING_COLORS = {
  tortuosity: { hex: 0x00ddff, css: 'rgb(0,221,255)', label: 'Tortuosity', badge: 'bg-cyan-900/50 text-cyan-400' },
  stenosis:   { hex: 0xffcc00, css: 'rgb(255,204,0)',  label: 'Stenosis',   badge: 'bg-yellow-900/50 text-yellow-400' },
  aneurysm:   { hex: 0xff6600, css: 'rgb(255,102,0)',  label: 'Aneurysm',   badge: 'bg-orange-900/50 text-orange-400' },
}

function rgbStr([r, g, b]) { return `rgb(${r},${g},${b})` }

/**
 * Collect all findings from analyze_response into a flat list
 * with the voxel-space centroid we'll use for 3D markers.
 */
function collectFindings(segments) {
  const findings = []
  if (!segments) return findings

  for (const meta of ARTERY_META) {
    const seg = segments[meta.key]
    if (!seg?.visible) continue
    const f = seg.findings || {}

    // Tortuosity — highlight entire centerline
    if (f.tortuosity?.flagged) {
      // Compute centroid of centerline for marker placement
      const cl = seg.centerline || []
      let cx = 0, cy = 0, cz = 0
      if (cl.length > 0) {
        for (const [x, y, z] of cl) { cx += x; cy += y; cz += z }
        cx /= cl.length; cy /= cl.length; cz /= cl.length
      }
      findings.push({
        type: 'tortuosity',
        arteryKey: meta.key,
        arteryName: meta.name,
        arteryRgb: meta.rgb,
        center: cl.length > 0 ? [cx, cy, cz] : null,
        centerline: cl,
        detail: `DF=${f.tortuosity.distance_factor?.toFixed(2)}, SoAM=${f.tortuosity.soam?.toFixed(3)}`,
        severity: f.tortuosity.distance_factor > 10 ? 'high' : f.tortuosity.distance_factor > 2 ? 'moderate' : 'low',
        data: f.tortuosity,
      })
    }

    // Stenosis
    for (const s of f.stenosis || []) {
      // Use mni_coordinates if available, otherwise try to estimate from centerline midpoint
      const mni = s.mni_coordinates
      findings.push({
        type: 'stenosis',
        arteryKey: meta.key,
        arteryName: meta.name,
        arteryRgb: meta.rgb,
        center: mni && mni.length === 3 ? mni : (seg.centerline?.length > 0 ? seg.centerline[Math.floor(seg.centerline.length / 2)] : null),
        detail: `${s.stenosis_percent?.toFixed(1)}% (${s.severity})`,
        severity: s.severity,
        data: s,
      })
    }

    // Aneurysms
    for (const a of f.aneurysms || []) {
      const mni = a.mni_coords
      findings.push({
        type: 'aneurysm',
        arteryKey: meta.key,
        arteryName: meta.name,
        arteryRgb: meta.rgb,
        center: mni && mni.length === 3 ? mni : (seg.centerline?.length > 0 ? seg.centerline[Math.floor(seg.centerline.length / 2)] : null),
        detail: `Size ratio ${a.size_ratio?.toFixed(2)}, ${a.confidence} conf.`,
        severity: a.confidence === 'high' ? 'high' : a.confidence === 'moderate' ? 'moderate' : 'low',
        data: a,
      })
    }
  }

  return findings
}

export default function FindingsViewer({ analyzeResponse }) {
  const mountRef = useRef(null)
  const rendererRef = useRef(null)
  const sceneRef = useRef(null)
  const cameraRef = useRef(null)
  const frameRef = useRef(null)
  const controlsRef = useRef(null)
  const markersGroupRef = useRef(null)
  const centroidRef = useRef([256, 256, 50])

  const [selectedFinding, setSelectedFinding] = useState(null)
  const [hoveredFinding, setHoveredFinding] = useState(null)
  const [autoRotate, setAutoRotate] = useState(true)

  const segments = analyzeResponse?.binary_segments ?? null
  const findings = useMemo(() => collectFindings(segments), [segments])

  // Arteries that have findings
  const findingArteryKeys = useMemo(
    () => new Set(findings.map(f => f.arteryKey)),
    [findings]
  )

  // ── Build scene ──────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !segments) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x070708)
    scene.fog = new THREE.FogExp2(0x070708, 0.0025)
    sceneRef.current = scene

    const w = mount.clientWidth
    const h = mount.clientHeight
    const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 2000)
    camera.position.set(0, 0, 350)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.8)
    dir1.position.set(100, 200, 150)
    scene.add(dir1)
    const dir2 = new THREE.DirectionalLight(0x8888ff, 0.3)
    dir2.position.set(-100, -50, -100)
    scene.add(dir2)

    const controls = createOrbitControls(camera, renderer.domElement)
    controlsRef.current = controls

    const onResize = () => {
      const w2 = mount.clientWidth
      const h2 = mount.clientHeight
      camera.aspect = w2 / h2
      camera.updateProjectionMatrix()
      renderer.setSize(w2, h2)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    const clock = new THREE.Clock()
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate)
      const t = clock.getElapsedTime()
      controls.update()

      // Pulse the markers
      if (markersGroupRef.current) {
        markersGroupRef.current.children.forEach(child => {
          if (child.userData.isMarker) {
            const pulse = 1.0 + 0.25 * Math.sin(t * 3 + child.userData.phase)
            child.scale.setScalar(pulse)
          }
          if (child.userData.isRing) {
            child.rotation.z = t * 0.8 + child.userData.phase
            const pulse = 1.0 + 0.15 * Math.sin(t * 2 + child.userData.phase)
            child.scale.setScalar(pulse)
          }
        })
      }

      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(frameRef.current)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      if (mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [segments])

  // ── Build vessel geometry + finding markers ─────────────────────────
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !segments) return

    // Remove old
    if (markersGroupRef.current) {
      scene.remove(markersGroupRef.current)
      markersGroupRef.current.traverse(child => {
        if (child.geometry) child.geometry.dispose()
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose())
          else child.material.dispose()
        }
      })
    }

    const group = new THREE.Group()
    markersGroupRef.current = group

    // Compute centroid
    let totalX = 0, totalY = 0, totalZ = 0, totalCount = 0
    for (const meta of ARTERY_META) {
      const seg = segments[meta.key]
      if (!seg?.visible || !seg.data?.length) continue
      for (const [x, y, z] of seg.data) {
        totalX += x; totalY += y; totalZ += z
        totalCount++
      }
    }
    const cx = totalCount > 0 ? totalX / totalCount : 256
    const cy = totalCount > 0 ? totalY / totalCount : 256
    const cz = totalCount > 0 ? totalZ / totalCount : 50
    centroidRef.current = [cx, cy, cz]

    // Build vessels — dim arteries without findings, bright for those with
    for (const meta of ARTERY_META) {
      const seg = segments[meta.key]
      if (!seg?.visible || !seg.data?.length) continue

      const hasFinding = findingArteryKeys.has(meta.key)
      const isSelected = selectedFinding?.arteryKey === meta.key
      const isHovered = hoveredFinding?.arteryKey === meta.key
      const [r, g, b] = meta.rgb
      const baseColor = new THREE.Color(r / 255, g / 255, b / 255)

      // Dim arteries without findings
      const opacity = hasFinding ? (isSelected || isHovered ? 0.95 : 0.75) : 0.15
      const ptSize = hasFinding ? (isSelected || isHovered ? 3.0 : 2.2) : 1.5

      const positions = new Float32Array(seg.data.length * 3)
      const colors = new Float32Array(seg.data.length * 3)
      for (let i = 0; i < seg.data.length; i++) {
        const [x, y, z] = seg.data[i]
        positions[i * 3]     = x - cx
        positions[i * 3 + 1] = z - cz
        positions[i * 3 + 2] = -(y - cy)
        colors[i * 3]     = baseColor.r
        colors[i * 3 + 1] = baseColor.g
        colors[i * 3 + 2] = baseColor.b
      }

      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const material = new THREE.PointsMaterial({
        size: ptSize,
        vertexColors: true,
        sizeAttenuation: true,
        transparent: true,
        opacity,
      })
      const points = new THREE.Points(geometry, material)
      points.userData = { arteryKey: meta.key }
      group.add(points)

      // For arteries with tortuosity findings, add a highlighted tube along centerline
      if (hasFinding && seg.centerline?.length > 1) {
        const finding = findings.find(f => f.arteryKey === meta.key && f.type === 'tortuosity')
        if (finding) {
          const curvePoints = seg.centerline.map(
            ([x, y, z]) => new THREE.Vector3(x - cx, z - cz, -(y - cy))
          )
          const curve = new THREE.CatmullRomCurve3(curvePoints, false, 'catmullrom', 0.5)
          const tubeRadius = Math.max(1.2, (seg.mean_radius_mm || 1) * 3)
          const tubeGeom = new THREE.TubeGeometry(curve, Math.max(8, seg.centerline.length * 2), tubeRadius, 8, false)

          const findingColor = new THREE.Color(FINDING_COLORS.tortuosity.hex)
          const tubeMat = new THREE.MeshPhongMaterial({
            color: isSelected || isHovered ? findingColor : baseColor,
            emissive: findingColor,
            emissiveIntensity: isSelected || isHovered ? 0.6 : 0.2,
            shininess: 60,
            transparent: true,
            opacity: isSelected || isHovered ? 0.9 : 0.45,
          })
          const tubeMesh = new THREE.Mesh(tubeGeom, tubeMat)
          tubeMesh.userData = { arteryKey: meta.key, findingType: 'tortuosity' }
          group.add(tubeMesh)
        }
      }
    }

    // Add 3D markers at finding locations
    for (let fi = 0; fi < findings.length; fi++) {
      const finding = findings[fi]
      if (!finding.center) continue

      const [fx, fy, fz] = finding.center
      const pos = new THREE.Vector3(fx - cx, fz - cz, -(fy - cy))
      const fColor = new THREE.Color(FINDING_COLORS[finding.type]?.hex ?? 0xffffff)
      const isActive = selectedFinding === finding || hoveredFinding === finding

      // Glowing sphere marker
      const markerGeom = new THREE.SphereGeometry(isActive ? 5 : 3.5, 16, 16)
      const markerMat = new THREE.MeshPhongMaterial({
        color: fColor,
        emissive: fColor,
        emissiveIntensity: isActive ? 1.0 : 0.5,
        transparent: true,
        opacity: isActive ? 1.0 : 0.8,
      })
      const marker = new THREE.Mesh(markerGeom, markerMat)
      marker.position.copy(pos)
      marker.userData = { isMarker: true, phase: fi * 1.5, findingIndex: fi }
      group.add(marker)

      // Ring around the marker
      const ringGeom = new THREE.TorusGeometry(isActive ? 8 : 5.5, 0.4, 8, 32)
      const ringMat = new THREE.MeshBasicMaterial({
        color: fColor,
        transparent: true,
        opacity: isActive ? 0.7 : 0.35,
      })
      const ring = new THREE.Mesh(ringGeom, ringMat)
      ring.position.copy(pos)
      ring.userData = { isRing: true, phase: fi * 1.5 }
      group.add(ring)
    }

    // Grid helper (horizontal in Y-up space)
    const gridHelper = new THREE.GridHelper(400, 40, 0x222233, 0x111122)
    gridHelper.position.y = -50
    group.add(gridHelper)

    scene.add(group)
  }, [segments, findings, findingArteryKeys, selectedFinding, hoveredFinding])

  // ── Auto-rotate ────────────────────────────────────────────────────
  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate
    }
  }, [autoRotate])

  // ── Fly camera to finding on click ─────────────────────────────────
  const flyToFinding = useCallback((finding) => {
    setSelectedFinding(finding)
    setAutoRotate(false)

    if (!finding?.center || !controlsRef.current || !cameraRef.current) return

    const [cx, cy, cz] = centroidRef.current
    const [fx, fy, fz] = finding.center
    const target = new THREE.Vector3(fx - cx, fz - cz, -(fy - cy))

    controlsRef.current.flyTo(target, 180)
  }, [])

  if (!segments) {
    return (
      <div className="flex items-center justify-center h-full bg-[#070708]">
        <p className="text-sm text-gray-600">No vessel data available.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-[#070708]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-gray-900/90 border-b border-gray-800 shrink-0 backdrop-blur">
        <span className="text-xs font-semibold text-gray-300">Findings Map</span>

        <div className="w-px h-4 bg-gray-700 mx-1" />

        <span className="text-[10px] text-gray-500">
          {findings.length} finding{findings.length !== 1 ? 's' : ''} across{' '}
          {findingArteryKeys.size} arter{findingArteryKeys.size !== 1 ? 'ies' : 'y'}
        </span>

        <div className="w-px h-4 bg-gray-700 mx-1" />

        <button
          onClick={() => setAutoRotate(!autoRotate)}
          className={`px-2.5 py-1 text-xs rounded font-semibold transition-all ${
            autoRotate
              ? 'bg-purple-500/30 text-purple-300 border border-purple-500/40'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          {autoRotate ? 'Rotating' : 'Static'}
        </button>

        {selectedFinding && (
          <button
            onClick={() => setSelectedFinding(null)}
            className="px-2.5 py-1 text-xs rounded font-semibold bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white"
          >
            Clear selection
          </button>
        )}

        <span className="ml-auto text-xs text-gray-600 hidden sm:block">
          Click a finding to fly to it
        </span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Findings sidebar */}
        <div className="w-64 shrink-0 border-r border-gray-800 overflow-y-auto bg-gray-950/80">
          <div className="px-3 py-2 border-b border-gray-800">
            <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wide">
              Detected Findings
            </span>
          </div>

          {findings.length === 0 ? (
            <div className="px-3 py-4 text-xs text-gray-600 text-center">
              No findings detected.
            </div>
          ) : (
            <div className="space-y-0.5 p-1.5">
              {findings.map((finding, i) => {
                const fCfg = FINDING_COLORS[finding.type]
                const isSelected2 = selectedFinding === finding
                const isHovered2 = hoveredFinding === finding

                return (
                  <button
                    key={i}
                    onClick={() => flyToFinding(finding)}
                    onMouseEnter={() => setHoveredFinding(finding)}
                    onMouseLeave={() => setHoveredFinding(null)}
                    className={`w-full text-left rounded-lg px-3 py-2.5 transition-all border ${
                      isSelected2
                        ? 'bg-white/5 border-white/15 shadow-lg'
                        : isHovered2
                          ? 'bg-white/[0.03] border-white/10'
                          : 'bg-transparent border-transparent hover:bg-white/[0.02]'
                    }`}
                  >
                    {/* Artery name + finding type badge */}
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{
                          background: rgbStr(finding.arteryRgb),
                          boxShadow: isSelected2 || isHovered2
                            ? `0 0 6px ${rgbStr(finding.arteryRgb)}`
                            : 'none',
                        }}
                      />
                      <span className="text-xs font-semibold text-gray-200 truncate">
                        {finding.arteryName}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ml-auto shrink-0 ${fCfg.badge}`}>
                        {fCfg.label}
                      </span>
                    </div>

                    {/* Detail line */}
                    <p className="text-[10px] text-gray-500 leading-snug pl-4">
                      {finding.detail}
                    </p>

                    {/* Severity indicator */}
                    <div className="flex items-center gap-1.5 mt-1.5 pl-4">
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        finding.severity === 'high' ? 'bg-red-500' :
                        finding.severity === 'moderate' ? 'bg-yellow-500' :
                        finding.severity === 'severe' ? 'bg-red-500' : 'bg-green-500'
                      }`} />
                      <span className={`text-[9px] font-medium uppercase tracking-wider ${
                        finding.severity === 'high' || finding.severity === 'severe' ? 'text-red-400' :
                        finding.severity === 'moderate' ? 'text-yellow-400' : 'text-green-400'
                      }`}>
                        {finding.severity}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 3D Canvas */}
        <div ref={mountRef} className="flex-1 min-h-0 relative">
          {/* Stats overlay */}
          <div className="absolute top-3 left-3 z-10 flex flex-col gap-1">
            <div className="px-2 py-1 rounded-lg bg-black/60 backdrop-blur-sm border border-white/5">
              <span className="text-[10px] text-gray-400">
                {findings.length} finding{findings.length !== 1 ? 's' : ''} ·{' '}
                {ARTERY_META.filter(m => segments[m.key]?.visible).length} arteries
              </span>
            </div>
          </div>

          {/* Legend */}
          <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1">
            {Object.entries(FINDING_COLORS).map(([type, cfg]) => {
              const count = findings.filter(f => f.type === type).length
              if (count === 0) return null
              return (
                <div
                  key={type}
                  className="flex items-center gap-2 px-2 py-1 rounded-lg bg-black/60 backdrop-blur-sm border border-white/5"
                >
                  <span className="w-2 h-2 rounded-full" style={{ background: cfg.css, boxShadow: `0 0 4px ${cfg.css}` }} />
                  <span className="text-[10px] text-gray-400">{cfg.label} ({count})</span>
                </div>
              )
            })}
          </div>

          {/* Selected finding overlay */}
          {selectedFinding && (
            <div
              className="absolute top-3 right-3 z-10 max-w-xs rounded-lg border backdrop-blur-sm px-3 py-2"
              style={{
                background: 'rgba(0,0,0,0.7)',
                borderColor: FINDING_COLORS[selectedFinding.type]?.css ?? '#fff',
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ background: rgbStr(selectedFinding.arteryRgb), boxShadow: `0 0 6px ${rgbStr(selectedFinding.arteryRgb)}` }}
                />
                <span className="text-xs font-bold text-white">{selectedFinding.arteryName}</span>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${FINDING_COLORS[selectedFinding.type]?.badge}`}>
                  {FINDING_COLORS[selectedFinding.type]?.label}
                </span>
              </div>
              <p className="text-[11px] text-gray-300 leading-snug">
                {selectedFinding.detail}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Simple orbit controls (same as Vessel3DViewer with flyTo added) ─────
function createOrbitControls(camera, domElement) {
  let isDragging = false
  let isRightDrag = false
  let prevX = 0, prevY = 0
  let theta = 0, phi = Math.PI / 2
  let radius = camera.position.length()
  let target = new THREE.Vector3(0, 0, 0)
  let _autoRotate = true

  // Smooth fly-to animation state
  let flyTarget = null
  let flyStartTarget = null
  let flyStartRadius = 0
  let flyProgress = 0
  let flyDuration = 0.8 // seconds
  let flyEndRadius = 180

  const onMouseDown = (e) => {
    isDragging = true
    isRightDrag = e.button === 2
    prevX = e.clientX
    prevY = e.clientY
    flyTarget = null // cancel fly on manual interaction
  }

  const onMouseMove = (e) => {
    if (!isDragging) return
    const dx = e.clientX - prevX
    const dy = e.clientY - prevY
    prevX = e.clientX
    prevY = e.clientY

    if (isRightDrag) {
      const panSpeed = 0.5
      const right = new THREE.Vector3()
      const up = new THREE.Vector3()
      right.setFromMatrixColumn(camera.matrix, 0)
      up.setFromMatrixColumn(camera.matrix, 1)
      target.add(right.multiplyScalar(-dx * panSpeed))
      target.add(up.multiplyScalar(dy * panSpeed))
    } else {
      theta -= dx * 0.005
      phi -= dy * 0.005
      phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi))
    }
  }

  const onMouseUp = () => { isDragging = false; isRightDrag = false }

  const onWheel = (e) => {
    radius *= e.deltaY > 0 ? 1.08 : 0.92
    radius = Math.max(50, Math.min(1000, radius))
    e.preventDefault()
    flyTarget = null
  }

  const onContextMenu = (e) => e.preventDefault()

  domElement.addEventListener('mousedown', onMouseDown)
  domElement.addEventListener('mousemove', onMouseMove)
  domElement.addEventListener('mouseup', onMouseUp)
  domElement.addEventListener('wheel', onWheel, { passive: false })
  domElement.addEventListener('contextmenu', onContextMenu)

  // Touch support
  let lastTouchDist = 0
  const onTouchStart = (e) => {
    if (e.touches.length === 1) {
      isDragging = true
      prevX = e.touches[0].clientX
      prevY = e.touches[0].clientY
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      lastTouchDist = Math.sqrt(dx * dx + dy * dy)
    }
  }
  const onTouchMove = (e) => {
    if (e.touches.length === 1 && isDragging) {
      const dx = e.touches[0].clientX - prevX
      const dy = e.touches[0].clientY - prevY
      prevX = e.touches[0].clientX
      prevY = e.touches[0].clientY
      theta -= dx * 0.005
      phi -= dy * 0.005
      phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi))
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (lastTouchDist > 0) {
        radius *= lastTouchDist / dist
        radius = Math.max(50, Math.min(1000, radius))
      }
      lastTouchDist = dist
    }
  }
  const onTouchEnd = () => { isDragging = false; lastTouchDist = 0 }

  domElement.addEventListener('touchstart', onTouchStart, { passive: true })
  domElement.addEventListener('touchmove', onTouchMove, { passive: true })
  domElement.addEventListener('touchend', onTouchEnd)

  let lastTime = performance.now()

  return {
    get autoRotate() { return _autoRotate },
    set autoRotate(v) { _autoRotate = v },

    flyTo(newTarget, newRadius) {
      flyStartTarget = target.clone()
      flyStartRadius = radius
      flyTarget = newTarget.clone()
      flyEndRadius = newRadius ?? 180
      flyProgress = 0
    },

    update() {
      const now = performance.now()
      const dt = (now - lastTime) / 1000
      lastTime = now

      // Handle fly-to animation
      if (flyTarget) {
        flyProgress = Math.min(1, flyProgress + dt / flyDuration)
        const t = 1 - Math.pow(1 - flyProgress, 3) // ease-out cubic
        target.lerpVectors(flyStartTarget, flyTarget, t)
        radius = flyStartRadius + (flyEndRadius - flyStartRadius) * t
        if (flyProgress >= 1) flyTarget = null
      }

      if (_autoRotate && !isDragging && !flyTarget) {
        theta += 0.003
      }
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.cos(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.sin(theta),
      )
      camera.lookAt(target)
    },

    dispose() {
      domElement.removeEventListener('mousedown', onMouseDown)
      domElement.removeEventListener('mousemove', onMouseMove)
      domElement.removeEventListener('mouseup', onMouseUp)
      domElement.removeEventListener('wheel', onWheel)
      domElement.removeEventListener('contextmenu', onContextMenu)
      domElement.removeEventListener('touchstart', onTouchStart)
      domElement.removeEventListener('touchmove', onTouchMove)
      domElement.removeEventListener('touchend', onTouchEnd)
    },
  }
}
