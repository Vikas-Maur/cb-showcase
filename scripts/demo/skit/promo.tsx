export default (
  <timeline aspect="16:9">
    <track name="Titles">
      <text name="Headline" start={1} end={6} textContent="Morning Brew" fontSize={150} fontWeight="bold" color="#FFF4E6" textAlign="center" shadowColor="#000000" shadowBlur={18} shadowOffsetX={0} shadowOffsetY={6} transform={{ x: 0, y: 60, scale: 1, rotation: 0 }} />
      <text name="Tagline" start={6} end={11} textContent="Fresh roast, every morning" fontSize={84} fontWeight="bold" color="#FFF4E6" textAlign="center" shadowColor="#000000" shadowBlur={12} shadowOffsetX={0} shadowOffsetY={4} />
      <text name="Offer" start={11} end={16} textContent="20% off this week" fontSize={96} fontWeight="bold" color="#2B1A12" textAlign="center" backgroundColor="#F6C177" backgroundOpacity={0.95} backgroundPadding={32} transform={{ x: 0, y: 260, scale: 1, rotation: 0 }} />
      <text name="Hours" start={16} end={20} textContent="Open from 7am" fontSize={84} color="#FFF4E6" textAlign="center" shadowColor="#000000" shadowBlur={12} shadowOffsetX={0} shadowOffsetY={4} />
      <text name="Outro" start={20} end={24} textContent="Morning Brew · Main Street" fontSize={72} fontWeight="bold" color="#FFF4E6" textAlign="center" transform={{ x: 0, y: 300, scale: 1, rotation: 0 }} />
    </track>
    <track name="Graphics">
      <code
        name="Cup reveal"
        start={0}
        end={6}
        codeComposition={{
          width: 1920,
          height: 1080,
          source:
            "export default function Graphic({ time, width, height }) {\n  const k = Math.min(1, time / 1.2);\n  const ease = 1 - Math.pow(1 - k, 3);\n  const r = 150 + 30 * ease;\n  return (\n    <svg width={width} height={height} viewBox=\"0 0 1920 1080\">\n      <circle cx={960} cy={360} r={r} fill=\"none\" stroke=\"#F6C177\" strokeWidth={10} opacity={ease} />\n      <rect x={890} y={300} width={140} height={110} rx={18} fill=\"#FFF4E6\" opacity={ease} />\n      <path d=\"M1030 325 q50 0 50 40 q0 40 -50 40\" fill=\"none\" stroke=\"#FFF4E6\" strokeWidth={14} opacity={ease} />\n    </svg>\n  );\n}\n",
        }}
      />
      <code
        name="Price burst"
        start={11}
        end={16}
        codeComposition={{
          width: 1920,
          height: 1080,
          source:
            "export default function Graphic({ time, width, height }) {\n  const spin = time * 20;\n  const pop = Math.min(1, time / 0.5);\n  const points = [];\n  for (let i = 0; i < 24; i++) {\n    const a = (i / 24) * Math.PI * 2;\n    const rr = i % 2 === 0 ? 260 : 200;\n    points.push(`${960 + Math.cos(a) * rr * pop},${470 + Math.sin(a) * rr * pop}`);\n  }\n  return (\n    <svg width={width} height={height} viewBox=\"0 0 1920 1080\">\n      <g transform={`rotate(${spin} 960 470)`}>\n        <polygon points={points.join(' ')} fill=\"#E07A3F\" opacity={0.9} />\n      </g>\n    </svg>\n  );\n}\n",
        }}
      />
    </track>
    <track name="Steam">
      <code
        name="Steam"
        start={0}
        end={24}
        codeComposition={{
          width: 1920,
          height: 1080,
          source:
            "export default function Graphic({ time, width, height }) {\n  const lines = [0, 1, 2].map((i) => {\n    const t = (time * 0.35 + i / 3) % 1;\n    const y = 980 - t * 520;\n    const x = 1660 + i * 70 + Math.sin(time * 1.5 + i) * 18;\n    return <path key={i} d={`M${x} ${y} q 30 -40 0 -80 q -30 -40 0 -80`} fill=\"none\" stroke=\"#FFF4E6\" strokeWidth={8} strokeLinecap=\"round\" opacity={0.5 * (1 - t)} />;\n  });\n  return <svg width={width} height={height} viewBox=\"0 0 1920 1080\">{lines}</svg>;\n}\n",
        }}
      />
    </track>
    <track name="Background">
      <code
        name="Roast gradient"
        start={0}
        end={24}
        codeComposition={{
          width: 1920,
          height: 1080,
          source:
            "export default function Graphic({ time, width, height }) {\n  const angle = 120 + 18 * Math.sin(time * 0.35);\n  const mid = 48 + 8 * Math.sin(time * 0.25);\n  return <div style={{ width, height, background: `linear-gradient(${angle}deg, #2B1A12 0%, #6B3B21 ${mid}%, #C98B4A 100%)` }} />;\n}\n",
        }}
      />
    </track>
  </timeline>
);
