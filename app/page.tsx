import { brand } from "@/lib/brand";

export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
      }}
    >
      <h1>{brand.name}</h1>
      <p style={{ maxWidth: "40rem", textAlign: "center" }}>{brand.tagline}</p>
      <hr className="divider" style={{ width: "8rem" }} />
      <p>
        <span style={{ color: "var(--kramer-mint)" }}>M1 — Foundation</span>
      </p>
    </main>
  );
}
