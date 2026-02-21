export default function OrderConfirmation({ order, onDismiss }) {
  if (!order) return null;

  return (
    <div className="order-overlay">
      <div className="order-modal">
        <div className="order-success-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </div>
        <h2>Order Placed!</h2>
        <p className="order-id">Order #{order.orderId}</p>

        <div className="order-details">
          {order.items.map((item, i) => (
            <div key={i} className="order-line">
              <span>
                {item.quantity}x {item.name}
              </span>
              <span>${item.subtotal.toFixed(2)}</span>
            </div>
          ))}
          <div className="order-divider" />
          <div className="order-line">
            <span>Subtotal</span>
            <span>${order.subtotal.toFixed(2)}</span>
          </div>
          <div className="order-line">
            <span>Shipping ({order.shippingMethod})</span>
            <span>${order.shipping.toFixed(2)}</span>
          </div>
          <div className="order-divider" />
          <div className="order-line order-total">
            <span>Total</span>
            <span>${order.total.toFixed(2)}</span>
          </div>
        </div>

        <button className="btn-primary" onClick={onDismiss}>
          Continue Shopping
        </button>
      </div>
    </div>
  );
}
