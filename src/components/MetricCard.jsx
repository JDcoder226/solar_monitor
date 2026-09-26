import Icon from "./Icon.jsx";

const BAR_COLOR = {
  blue: "bg-[#3f79bd]",
  rose: "bg-[#e66a6a]",
  slate: "bg-[#55636d]",
  sun: "bg-[#f7a928]",
};

export default function MetricCard({ title, value, unit, detail, icon, tone = "sun", progress }) {
  return (
    <article className="card p-5 flex flex-col justify-between min-h-[156px] fade">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-xs font-semibold tracking-wide uppercase text-slate-500">{title}</p>
          <div className="flex items-baseline gap-2 mt-3">
            <strong className="mono text-[28px] leading-none">{value}</strong>
            <span className="mono text-xs text-slate-500">{unit}</span>
          </div>
        </div>
        <div className={`metric-icon ${tone}`}>
          <Icon name={icon} />
        </div>
      </div>
      <div className="mt-5">
        <div className="flex justify-between text-xs text-slate-500">
          <span>{detail}</span>
          {/* `!= null` couvre null ET undefined : une barre absente (pas de
              donnee, ou capacite inconnue) ne doit pas afficher « null % ». */}
          {progress != null && <span className="mono">{progress}%</span>}
        </div>
        {progress != null && (
          <div className="h-1.5 bg-slate-100 rounded mt-2 overflow-hidden">
            <div
              className={`h-full rounded ${BAR_COLOR[tone] || BAR_COLOR.sun}`}
              style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
            />
          </div>
        )}
      </div>
    </article>
  );
}
