import { useState } from "react";
import { CartProvider, useCart } from "./context/CartContext";
import { useWebMCP } from "./hooks/useWebMCP";
import Header from "./components/Header";
import ProductList from "./components/ProductList";
import CartView from "./components/CartView";
import OrderConfirmation from "./components/OrderConfirmation";
import WebMCPStatus from "./components/WebMCPStatus";

function AppContent() {
  const [view, setView] = useState("products");
  const cart = useCart();

  useWebMCP(cart);

  return (
    <div className="app">
      <Header activeView={view} onViewChange={setView} />
      <main className="main-content">
        {view === "products" && <ProductList />}
        {view === "cart" && <CartView onViewChange={setView} />}
      </main>
      <OrderConfirmation
        order={cart.checkoutStatus}
        onDismiss={() => {
          cart.setCheckoutStatus(null);
          setView("products");
        }}
      />
      <WebMCPStatus />
    </div>
  );
}

export default function App() {
  return (
    <CartProvider>
      <AppContent />
    </CartProvider>
  );
}
