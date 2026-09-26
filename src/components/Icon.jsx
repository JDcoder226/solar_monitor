const ICONS = {
  sun: "☼",
  bolt: "ϟ",
  temp: "°",
  wave: "∿",
  refresh: "↻",
  database: "▦",
  model: "◈",
  logout: "⏻",
};

export default function Icon({ name }) {
  return (
    <span aria-hidden="true" className="text-lg leading-none">
      {ICONS[name] || "•"}
    </span>
  );
}
