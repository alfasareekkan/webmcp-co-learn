import { useEffect, useRef } from "react";
import { products } from "../data/products";

export function useWebMCP(cart) {
  const cartRef = useRef(cart);
  cartRef.current = cart;

  useEffect(() => {
    if (!navigator.modelContext) {
      console.warn(
        "WebMCP not available. Enable chrome://flags/#enable-webmcp-testing in Chrome 146+."
      );
      return;
    }

    const toolDefinitions = [
      {
        name: "search_products",
        description:
          "Search and browse available products in the store. Use this to find products by name, category, or to list all products. Returns product details including id, name, price, category, stock, and rating.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Search term to filter products by name or description. Leave empty to list all products.",
            },
            category: {
              type: "string",
              description:
                "Filter by product category.",
              enum: ["all", "electronics", "clothing", "accessories"],
            },
          },
        },
        execute: ({ query, category }) => {
          let results = [...products];
          if (category && category !== "all") {
            results = results.filter((p) => p.category === category);
          }
          if (query) {
            const q = query.toLowerCase();
            results = results.filter(
              (p) =>
                p.name.toLowerCase().includes(q) ||
                p.description.toLowerCase().includes(q)
            );
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  results.map((p) => ({
                    id: p.id,
                    name: p.name,
                    price: `$${p.price}`,
                    category: p.category,
                    stock: p.stock,
                    rating: p.rating,
                  })),
                  null,
                  2
                ),
              },
            ],
          };
        },
      },
      {
        name: "add_to_cart",
        description:
          "Add a product to the shopping cart. Requires the product ID and an optional quantity (defaults to 1). Use search_products first to find valid product IDs.",
        inputSchema: {
          type: "object",
          properties: {
            productId: {
              type: "string",
              description:
                'The unique product ID (e.g. "prod-001"). Use search_products to find available IDs.',
            },
            quantity: {
              type: "number",
              description:
                "Number of items to add. Defaults to 1. Must be a positive integer.",
            },
          },
          required: ["productId"],
        },
        execute: ({ productId, quantity = 1 }) => {
          const product = products.find((p) => p.id === productId);
          if (!product) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Product "${productId}" not found. Use search_products to find valid product IDs.`,
                },
              ],
            };
          }
          if (quantity < 1 || !Number.isInteger(quantity)) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: Quantity must be a positive integer.",
                },
              ],
            };
          }
          if (quantity > product.stock) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Only ${product.stock} units of "${product.name}" are in stock.`,
                },
              ],
            };
          }
          cartRef.current.addItem(product, quantity);
          return {
            content: [
              {
                type: "text",
                text: `Added ${quantity}x "${product.name}" ($${product.price} each) to cart.`,
              },
            ],
          };
        },
      },
      {
        name: "remove_from_cart",
        description:
          "Remove a product entirely from the shopping cart by its product ID.",
        inputSchema: {
          type: "object",
          properties: {
            productId: {
              type: "string",
              description: "The product ID to remove from the cart.",
            },
          },
          required: ["productId"],
        },
        execute: ({ productId }) => {
          const item = cartRef.current.items.find((i) => i.id === productId);
          if (!item) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Product "${productId}" is not in the cart.`,
                },
              ],
            };
          }
          cartRef.current.removeItem(productId);
          return {
            content: [
              {
                type: "text",
                text: `Removed "${item.name}" from cart.`,
              },
            ],
          };
        },
      },
      {
        name: "update_cart_quantity",
        description:
          "Update the quantity of a product already in the cart. Set quantity to 0 to remove it.",
        inputSchema: {
          type: "object",
          properties: {
            productId: {
              type: "string",
              description: "The product ID in the cart to update.",
            },
            quantity: {
              type: "number",
              description:
                "New quantity. Set to 0 to remove the item from the cart.",
            },
          },
          required: ["productId", "quantity"],
        },
        execute: ({ productId, quantity }) => {
          const item = cartRef.current.items.find((i) => i.id === productId);
          if (!item) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Product "${productId}" is not in the cart.`,
                },
              ],
            };
          }
          cartRef.current.updateQuantity(productId, quantity);
          const action = quantity === 0 ? "Removed" : `Updated to ${quantity}x`;
          return {
            content: [
              {
                type: "text",
                text: `${action} "${item.name}" in cart.`,
              },
            ],
          };
        },
      },
      {
        name: "get_cart",
        description:
          "Get the current shopping cart contents, including all items, quantities, prices, and the total amount.",
        inputSchema: {
          type: "object",
          properties: {},
        },
        execute: () => {
          const { items, cartTotal } = cartRef.current;
          if (items.length === 0) {
            return {
              content: [
                { type: "text", text: "The cart is empty." },
              ],
            };
          }
          const summary = items.map((i) => ({
            id: i.id,
            name: i.name,
            price: `$${i.price}`,
            quantity: i.quantity,
            subtotal: `$${(i.price * i.quantity).toFixed(2)}`,
          }));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { items: summary, total: `$${cartTotal.toFixed(2)}` },
                  null,
                  2
                ),
              },
            ],
          };
        },
      },
      {
        name: "clear_cart",
        description: "Remove all items from the shopping cart at once.",
        inputSchema: {
          type: "object",
          properties: {},
        },
        execute: () => {
          cartRef.current.clearCart();
          return {
            content: [{ type: "text", text: "Cart has been cleared." }],
          };
        },
      },
      {
        name: "checkout",
        description:
          "Proceed to checkout with the current cart contents. This places the order. The cart must not be empty.",
        inputSchema: {
          type: "object",
          properties: {
            shippingMethod: {
              type: "string",
              description:
                "Shipping speed. Use 'standard' for 5-7 business days, 'express' for 2-3 business days, or 'overnight' for next-day delivery.",
              enum: ["standard", "express", "overnight"],
            },
          },
        },
        execute: ({ shippingMethod = "standard" }) => {
          const { items, cartTotal } = cartRef.current;
          if (items.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: Cannot checkout with an empty cart. Add items first.",
                },
              ],
            };
          }
          const shippingCosts = { standard: 0, express: 9.99, overnight: 19.99 };
          const shipping = shippingCosts[shippingMethod] || 0;
          const orderId = `ORD-${Date.now().toString(36).toUpperCase()}`;

          cartRef.current.setCheckoutStatus({
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
          cartRef.current.clearCart();

          return {
            content: [
              {
                type: "text",
                text: `Order ${orderId} placed successfully! Subtotal: $${cartTotal.toFixed(2)}, Shipping (${shippingMethod}): $${shipping.toFixed(2)}, Total: $${(cartTotal + shipping).toFixed(2)}.`,
              },
            ],
          };
        },
      },
    ];

    navigator.modelContext.provideContext({ tools: toolDefinitions });

    return () => {
      if (navigator.modelContext?.clearContext) {
        navigator.modelContext.clearContext();
      }
    };
  }, []);
}
