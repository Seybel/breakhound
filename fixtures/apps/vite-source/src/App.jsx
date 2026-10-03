// A page with one known bug: a banner with a fixed width wider than phones.
function Card({ children }) {
  return <section className="card">{children}</section>;
}

export function App() {
  return (
    <main>
      <h1>Pricing</h1>
      <Card>
        <div className="banner" style={{ width: 600, background: '#eee' }}>
          A banner with a fixed width
        </div>
      </Card>
    </main>
  );
}
