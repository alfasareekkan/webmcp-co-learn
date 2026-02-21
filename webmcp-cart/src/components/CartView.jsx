import { useCart } from "../context/CartContext";

export default function CartView({ onViewChange }) {
  const { items, cartTotal, cartCount, removeItem, updateQuantity, clearCart, setCheckoutStatus } =
    useCart();

  const handleCheckout = (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const shippingMethod = formData.get("shipping") || "standard";
    const shippingCosts = { standard: 0, express: 9.99, overnight: 19.99 };
    const shipping = shippingCosts[shippingMethod] || 0;
    const orderId = `ORD-${Date.now().toString(36).toUpperCase()}`;

    if (e.agentInvoked) {
      e.respondWith(
        Promise.resolve(
          `Order ${orderId} placed! Total: $${(cartTotal + shipping).toFixed(2)} (shipping: ${shippingMethod})`
        )
      );
    }

    setCheckoutStatus({
      orderId,
      items: items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        subtotal: i.price * i.quantity,
      })),
      subtotal: cartTotal,
      shipping,
      total: cartTotal + shipping,
      shippingMethod,
    });
    clearCart();
  };

  if (items.length === 0) {
    return (
      <section className="cart-section">
        <div className="empty-cart">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
            <circle cx="9" cy="21" r="1" />
            <circle cx="20" cy="21" r="1" />
            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
          </svg>
          <h2>Your cart is empty</h2>
          <p>Browse our products and add items to get started.</p>
          <button className="btn-primary" onClick={() => onViewChange("products")}>
            Shop Now
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="cart-section">
      <div className="cart-header">
        <h2>Shopping Cart ({cartCount} items)</h2>
        <button className="btn-text-danger" onClick={clearCart}>
          Clear Cart
        </button>
      </div>

      <div className="cart-layout">
        <div className="cart-items">
          {items.map((item) => (
            <div key={item.id} className="cart-item">
              <img src={item.image} alt={item.name} className="cart-item-image" />
              <div className="cart-item-info">
                <h4>{item.name}</h4>
                <p className="cart-item-price">${item.price.toFixed(2)}</p>
              </div>
              <div className="cart-item-controls">
                <div className="quantity-control">
                  <button
                    className="qty-btn"
                    onClick={() => updateQuantity(item.id, item.quantity - 1)}
                  >
                    −
                  </button>
                  <span className="qty-value">{item.quantity}</span>
                  <button
                    className="qty-btn"
                    onClick={() => updateQuantity(item.id, item.quantity + 1)}
                  >
                    +
                  </button>
                </div>
                <span className="cart-item-subtotal">
                  ${(item.price * item.quantity).toFixed(2)}
                </span>
                <button className="btn-remove" onClick={() => removeItem(item.id)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="cart-summary">
          <h3>Order Summary</h3>

          <form
            toolname="checkout_order"
            tooldescription="Checkout and place an order with the current cart items. Select a shipping method and submit to complete the purchase."
            onSubmit={handleCheckout}
          >
            <div className="summary-row">
              <span>Subtotal</span>
              <span>${cartTotal.toFixed(2)}</span>
            </div>

            <div className="form-group">
              <label htmlFor="shipping">Shipping Method</label>
              <select
                name="shipping"
                id="shipping"
                toolparamtitle="shippingMethod"
                toolparamdescription="Shipping speed: 'standard' for free 5-7 day shipping, 'express' for $9.99 2-3 day shipping, or 'overnight' for $19.99 next-day delivery."
                defaultValue="standard"
              >
                <option value="standard">Standard (Free, 5-7 days)</option>
                <option value="express">Express ($9.99, 2-3 days)</option>
                <option value="overnight">Overnight ($19.99, next day)</option>
              </select>
            </div>

            <div className="summary-divider" />
            <div className="summary-row summary-total">
              <span>Total</span>
              <span>${cartTotal.toFixed(2)}</span>
            </div>

            <button type="submit" className="btn-checkout">
              Place Order
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
