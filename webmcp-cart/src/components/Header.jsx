import { useCart } from "../context/CartContext";

export default function Header({ activeView, onViewChange }) {
  const { cartCount } = useCart();

  return (
    <header className="header">
      <div className="header-inner">
        <div className="logo" onClick={() => onViewChange("products")}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="9" cy="21" r="1" />
            <circle cx="20" cy="21" r="1" />
            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
          </svg>
          <span>WebMCP Cart</span>
        </div>

        <nav className="nav-tabs">
          <button
            className={`nav-tab ${activeView === "products" ? "active" : ""}`}
            onClick={() => onViewChange("products")}
          >
            Products
          </button>
          <button
            className={`nav-tab ${activeView === "cart" ? "active" : ""}`}
            onClick={() => onViewChange("cart")}
          >
            Cart
            {cartCount > 0 && <span className="badge">{cartCount}</span>}
          </button>
        </nav>

        <div className="header-badge">
          <span className="webmcp-tag">WebMCP Enabled</span>
        </div>
      </div>
    </header>
  );
}
