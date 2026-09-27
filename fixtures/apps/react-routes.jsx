// Routes declared as JSX, with a second <Routes> nested inside a page component.
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Outlet, Route, Routes } from 'react-router';

const Page = ({ title }) => (
  <main>
    <h1>{title}</h1>
    <Link to="/products/42">A product</Link>
  </main>
);

function Settings() {
  return (
    <Routes>
      <Route index element={<Page title="Settings" />} />
      <Route path="profile" element={<Page title="Profile" />} />
      <Route path="billing/:plan?" element={<Page title="Billing" />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route index element={<Page title="Home" />} />
      <Route path="about" element={<Page title="About" />} />
      <Route element={<Outlet />}>
        <Route path="products/:id" element={<Page title="Product" />} />
      </Route>
      <Route path="settings/*" element={<Settings />} />
      <Route path="*" element={<Page title="Not found" />} />
    </Routes>
  </BrowserRouter>,
);
