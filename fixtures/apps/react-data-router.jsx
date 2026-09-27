// Routes declared as objects for a data router.
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router';

const Page = ({ title }) => <h1>{title}</h1>;

const router = createBrowserRouter([
  {
    path: '/',
    element: <Outlet />,
    children: [
      { index: true, element: <Page title="Home" /> },
      { path: 'blog', element: <Page title="Blog" /> },
      { path: 'blog/:slug', element: <Page title="Post" /> },
      { path: 'docs/*', element: <Page title="Docs" /> },
    ],
  },
]);

createRoot(document.getElementById('root')).render(<RouterProvider router={router} />);
