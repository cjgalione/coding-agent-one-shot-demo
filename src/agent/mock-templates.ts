import type { DatasetCase } from "../types.js";

type TemplateOutput = {
  app: string;
  css: string;
  test: string;
  summary: string;
  decisions: string[];
  risks: string[];
};

const sharedCss = String.raw`:root {
  color: #202825;
  background: #edf1ee;
  font-family:
    "Aptos",
    "Segoe UI",
    sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

button,
input,
select {
  font: inherit;
}

.app-shell {
  min-height: 100vh;
  padding: 28px;
  background:
    linear-gradient(135deg, rgb(255 255 255 / 82%), rgb(217 230 224 / 86%)),
    #edf1ee;
}

.workspace {
  width: min(1180px, 100%);
  margin: 0 auto;
  display: grid;
  gap: 18px;
}

.topbar,
.panel,
.form-panel {
  background: #ffffff;
  border: 1px solid #cdd8d2;
  border-radius: 8px;
  box-shadow: 0 14px 40px rgb(32 40 37 / 8%);
}

.topbar {
  padding: 24px;
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: flex-start;
}

.eyebrow {
  margin: 0 0 6px;
  color: #587064;
  font-size: 0.76rem;
  font-weight: 800;
  text-transform: uppercase;
}

h1,
h2 {
  margin: 0;
}

h1 {
  font-size: 2.4rem;
}

h2 {
  font-size: 1.1rem;
}

.metric-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.metric {
  min-width: 132px;
  padding: 14px;
  border: 1px solid #dce5e0;
  border-radius: 8px;
  background: #f8faf9;
}

.metric strong {
  display: block;
  font-size: 1.7rem;
}

.controls,
.content-grid,
.form-grid {
  display: grid;
  gap: 14px;
}

.content-grid {
  grid-template-columns: 1fr 320px;
  align-items: start;
}

.panel,
.form-panel {
  padding: 18px;
}

.controls {
  grid-template-columns: minmax(220px, 1fr) auto;
  margin: 16px 0;
}

.search,
.select,
.input {
  width: 100%;
  border: 1px solid #bdccc5;
  border-radius: 6px;
  padding: 10px 12px;
  background: #ffffff;
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.table th,
.table td {
  padding: 12px 10px;
  border-bottom: 1px solid #e5ece8;
  text-align: left;
}

.badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 4px 9px;
  background: #e7f0ec;
  color: #29453a;
  font-weight: 700;
  font-size: 0.82rem;
}

.badge.alert {
  background: #ffe5d7;
  color: #803d1a;
}

.button {
  border: 0;
  border-radius: 6px;
  padding: 10px 12px;
  background: #22483a;
  color: #ffffff;
  font-weight: 800;
  cursor: pointer;
}

.button.secondary {
  background: #e8efeb;
  color: #22483a;
}

.form-grid {
  margin-top: 16px;
}

.stack {
  display: grid;
  gap: 10px;
}

@media (max-width: 780px) {
  .app-shell {
    padding: 16px;
  }

  .topbar,
  .content-grid,
  .controls {
    grid-template-columns: 1fr;
    display: grid;
  }
}
`;

export function templateForCase(testCase: DatasetCase): TemplateOutput {
  if (testCase.id.startsWith("maintenance")) {
    return maintenanceTemplate();
  }
  if (testCase.id.startsWith("supplier")) {
    return supplierTemplate();
  }
  if (testCase.id.startsWith("fleet")) {
    return fleetTemplate();
  }
  if (testCase.id.startsWith("inventory")) {
    return inventoryTemplate();
  }
  return genericTemplate(testCase);
}

function genericTemplate(testCase: DatasetCase): TemplateOutput {
  const title = testCase.user_request
    .replace(/^Build an? /i, "")
    .replace(/\.$/, "");
  const terms = testCase.expected_ui_terms;
  const app = String.raw`import { useMemo, useState } from "react";

const focusTerms = ${JSON.stringify(terms, null, 2)};

type Item = {
  id: number;
  name: string;
  status: string;
  owner: string;
};

const starterItems: Item[] = focusTerms.map((term, index) => ({
  id: index + 1,
  name: term,
  status: index % 2 === 0 ? "Needs review" : "On track",
  owner: ["Operations", "Planning", "Customer team", "Finance"][index % 4]
}));

export default function App() {
  const [items, setItems] = useState(starterItems);
  const [query, setQuery] = useState("");
  const [newItem, setNewItem] = useState("");

  const visibleItems = useMemo(
    () => items.filter((item) => (item.name + item.status + item.owner).toLowerCase().includes(query.toLowerCase())),
    [items, query]
  );

  function addItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newItem.trim()) {
      return;
    }
    setItems((current) => [
      ...current,
      { id: Date.now(), name: newItem.trim(), status: "Needs review", owner: "Operations" }
    ]);
    setNewItem("");
  }

  return (
    <main className="app-shell">
      <div className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Generated vertical slice</p>
            <h1>${title}</h1>
          </div>
          <div className="metric-row">
            <div className="metric"><strong>{items.length}</strong><span>Records</span></div>
            <div className="metric"><strong>{focusTerms.length}</strong><span>Required UI terms</span></div>
          </div>
        </header>

        <section className="content-grid">
          <div className="panel">
            <h2>Operational workspace</h2>
            <div className="controls">
              <input className="search" aria-label="Search records" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search records" />
            </div>
            <table className="table">
              <thead><tr><th>Name</th><th>Status</th><th>Owner</th></tr></thead>
              <tbody>
                {visibleItems.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td><span className={item.status === "Needs review" ? "badge alert" : "badge"}>{item.status}</span></td>
                    <td>{item.owner}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form className="form-panel" onSubmit={addItem}>
            <h2>Add record</h2>
            <div className="form-grid">
              <input className="input" aria-label="Record name" value={newItem} onChange={(event) => setNewItem(event.target.value)} placeholder="New record" />
              <button className="button" type="submit">Add record</button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
`;
  const test = String.raw`import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";

it("renders the generated app workspace and supports adding a record", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: /operational workspace/i })).toBeInTheDocument();
  ${terms.map((term) => `expect(screen.getAllByText(/${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/i).length).toBeGreaterThan(0);`).join("\n  ")}

  fireEvent.change(screen.getByLabelText(/record name/i), { target: { value: "New operating record" } });
  fireEvent.click(screen.getByRole("button", { name: /add record/i }));
  expect(screen.getByText(/new operating record/i)).toBeInTheDocument();
});
`;

  return {
    app,
    css: sharedCss,
    test,
    summary: `Implemented a runnable vertical slice for ${testCase.id}.`,
    decisions: [
      "Used a generic app-builder mock template so the broader dataset can run without an LLM.",
      "Rendered every expected UI term to keep BasicUIHealth deterministic."
    ],
    risks: ["The mock implementation is intentionally generic; real evals use the coding model."]
  };
}

function inventoryTemplate(): TemplateOutput {
  const app = String.raw`import { useMemo, useState } from "react";

type Part = {
  id: number;
  name: string;
  location: string;
  quantity: number;
  reorderPoint: number;
};

const starterParts: Part[] = [
  { id: 1, name: "Hydraulic pump", location: "Aisle 4", quantity: 3, reorderPoint: 5 },
  { id: 2, name: "Servo motor", location: "Aisle 7", quantity: 12, reorderPoint: 4 },
  { id: 3, name: "Filter cartridge", location: "Line 2 cage", quantity: 2, reorderPoint: 8 }
];

export default function App() {
  const [parts, setParts] = useState(starterParts);
  const [query, setQuery] = useState("");
  const [showLowStock, setShowLowStock] = useState(false);
  const [newPart, setNewPart] = useState({ name: "", location: "", quantity: "1", reorderPoint: "5" });

  const filteredParts = useMemo(() => {
    return parts.filter((part) => {
      const matchesQuery = (part.name + " " + part.location).toLowerCase().includes(query.toLowerCase());
      const matchesStock = !showLowStock || part.quantity <= part.reorderPoint;
      return matchesQuery && matchesStock;
    });
  }, [parts, query, showLowStock]);

  const lowStockCount = parts.filter((part) => part.quantity <= part.reorderPoint).length;

  function addPart(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const quantity = Number(newPart.quantity);
    const reorderPoint = Number(newPart.reorderPoint);
    if (!newPart.name.trim() || !newPart.location.trim() || quantity < 0 || reorderPoint < 0) {
      return;
    }
    setParts((current) => [
      ...current,
      {
        id: Date.now(),
        name: newPart.name.trim(),
        location: newPart.location.trim(),
        quantity,
        reorderPoint
      }
    ]);
    setNewPart({ name: "", location: "", quantity: "1", reorderPoint: "5" });
  }

  return (
    <main className="app-shell">
      <div className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Operations inventory</p>
            <h1>Inventory dashboard</h1>
          </div>
          <div className="metric-row" aria-label="Inventory metrics">
            <div className="metric"><strong>{parts.length}</strong><span>Total parts</span></div>
            <div className="metric"><strong>{lowStockCount}</strong><span>Low stock</span></div>
          </div>
        </header>

        <section className="content-grid">
          <div className="panel">
            <h2>Parts list</h2>
            <div className="controls">
              <input className="search" aria-label="Search parts" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by part or location" />
              <label className="badge">
                <input type="checkbox" checked={showLowStock} onChange={(event) => setShowLowStock(event.target.checked)} /> Low stock only
              </label>
            </div>
            <table className="table">
              <thead>
                <tr><th>Part</th><th>Location</th><th>Qty</th><th>Status</th></tr>
              </thead>
              <tbody>
                {filteredParts.map((part) => (
                  <tr key={part.id}>
                    <td>{part.name}</td>
                    <td>{part.location}</td>
                    <td>{part.quantity}</td>
                    <td><span className={part.quantity <= part.reorderPoint ? "badge alert" : "badge"}>{part.quantity <= part.reorderPoint ? "Low stock" : "Healthy"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form className="form-panel" onSubmit={addPart}>
            <h2>Add part</h2>
            <div className="form-grid">
              <input className="input" aria-label="Part name" value={newPart.name} onChange={(event) => setNewPart({ ...newPart, name: event.target.value })} placeholder="Part name" />
              <input className="input" aria-label="Location" value={newPart.location} onChange={(event) => setNewPart({ ...newPart, location: event.target.value })} placeholder="Location" />
              <input className="input" aria-label="Quantity" type="number" value={newPart.quantity} onChange={(event) => setNewPart({ ...newPart, quantity: event.target.value })} />
              <input className="input" aria-label="Reorder point" type="number" value={newPart.reorderPoint} onChange={(event) => setNewPart({ ...newPart, reorderPoint: event.target.value })} />
              <button className="button" type="submit">Add part</button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
`;

  const test = String.raw`import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";

it("filters low stock parts and adds a new part", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: /inventory dashboard/i })).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(/low stock only/i));
  expect(screen.getByText(/hydraulic pump/i)).toBeInTheDocument();
  expect(screen.queryByText(/servo motor/i)).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/part name/i), { target: { value: "Bearing kit" } });
  fireEvent.change(screen.getByLabelText(/^location$/i), { target: { value: "Aisle 9" } });
  fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "6" } });
  fireEvent.change(screen.getByLabelText(/reorder point/i), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: /add part/i }));

  expect(screen.getByText(/bearing kit/i)).toBeInTheDocument();
});
`;

  return {
    app,
    css: sharedCss,
    test,
    summary: "Implemented a working inventory dashboard with low-stock filtering and add-part flow.",
    decisions: [
      "Kept the fixture frontend-only and used React state for the vertical slice.",
      "Extended the existing App test to cover filtering and adding a part."
    ],
    risks: ["Data is in-memory because the fixture has no backend or persistence layer."]
  };
}

function maintenanceTemplate(): TemplateOutput {
  const app = String.raw`import { useMemo, useState } from "react";

type WorkOrder = {
  id: number;
  asset: string;
  owner: string;
  due: string;
  status: "Open" | "Complete";
  overdue: boolean;
};

const starterOrders: WorkOrder[] = [
  { id: 1, asset: "Press line 2", owner: "Maya", due: "Today", status: "Open", overdue: true },
  { id: 2, asset: "Boiler inspection", owner: "Arun", due: "Friday", status: "Open", overdue: false },
  { id: 3, asset: "Packaging robot", owner: "Inez", due: "Yesterday", status: "Open", overdue: true }
];

export default function App() {
  const [orders, setOrders] = useState(starterOrders);
  const openOrders = orders.filter((order) => order.status === "Open");
  const overdueOrders = openOrders.filter((order) => order.overdue);
  const visibleOrders = useMemo(() => orders.filter((order) => order.status === "Open"), [orders]);

  function completeOrder(id: number) {
    setOrders((current) => current.map((order) => order.id === id ? { ...order, status: "Complete", overdue: false } : order));
  }

  return (
    <main className="app-shell">
      <div className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">Plant maintenance</p><h1>Maintenance work orders</h1></div>
          <div className="metric-row"><div className="metric"><strong>{openOrders.length}</strong><span>Open</span></div><div className="metric"><strong>{overdueOrders.length}</strong><span>Overdue</span></div></div>
        </header>
        <section className="panel">
          <h2>Open requests</h2>
          <table className="table">
            <thead><tr><th>Asset</th><th>Owner</th><th>Due</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>{visibleOrders.map((order) => <tr key={order.id}><td>{order.asset}</td><td>{order.owner}</td><td>{order.due}</td><td><span className={order.overdue ? "badge alert" : "badge"}>{order.overdue ? "Overdue" : "On track"}</span></td><td><button className="button secondary" onClick={() => completeOrder(order.id)}>Mark complete</button></td></tr>)}</tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
`;
  const test = String.raw`import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";

it("shows overdue work orders and completes one", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: /maintenance work orders/i })).toBeInTheDocument();
  expect(screen.getAllByText(/overdue/i).length).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByRole("button", { name: /mark complete/i })[0]);
  expect(screen.queryByText(/press line 2/i)).not.toBeInTheDocument();
});
`;
  return {
    app,
    css: sharedCss,
    test,
    summary: "Implemented a maintenance board with open work orders, overdue status, and completion action.",
    decisions: ["Modeled work orders locally to keep the fixture runnable.", "Focused the test on overdue visibility and completing work."],
    risks: ["Completion state resets on page reload because the fixture has no backend."]
  };
}

function supplierTemplate(): TemplateOutput {
  const app = String.raw`import { useState } from "react";

type Vendor = { id: number; name: string; category: string; risk: "Low" | "Medium" | "High"; rating: number };

const starterVendors: Vendor[] = [
  { id: 1, name: "Northstar Metals", category: "Raw materials", risk: "High", rating: 72 },
  { id: 2, name: "Acme Controls", category: "Electronics", risk: "Medium", rating: 84 },
  { id: 3, name: "Atlas Freight", category: "Logistics", risk: "Low", rating: 91 }
];

export default function App() {
  const [vendors, setVendors] = useState(starterVendors);
  const highRisk = vendors.filter((vendor) => vendor.risk === "High").length;

  function updateRating(id: number, rating: number) {
    setVendors((current) => current.map((vendor) => vendor.id === id ? { ...vendor, rating } : vendor));
  }

  return (
    <main className="app-shell">
      <div className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">Sourcing control tower</p><h1>Supplier scorecard</h1></div>
          <div className="metric-row"><div className="metric"><strong>{vendors.length}</strong><span>Vendors</span></div><div className="metric"><strong>{highRisk}</strong><span>Risk flags</span></div></div>
        </header>
        <section className="panel">
          <h2>Vendor comparison</h2>
          <table className="table">
            <thead><tr><th>Supplier</th><th>Category</th><th>Risk</th><th>Rating</th></tr></thead>
            <tbody>{vendors.map((vendor) => <tr key={vendor.id}><td>{vendor.name}</td><td>{vendor.category}</td><td><span className={vendor.risk === "High" ? "badge alert" : "badge"}>{vendor.risk} risk</span></td><td><input className="input" aria-label={vendor.name + " rating"} type="number" min="0" max="100" value={vendor.rating} onChange={(event) => updateRating(vendor.id, Number(event.target.value))} /></td></tr>)}</tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
`;
  const test = String.raw`import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";

it("compares vendors and updates a rating", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: /supplier scorecard/i })).toBeInTheDocument();
  expect(screen.getByText(/high risk/i)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/northstar metals rating/i), { target: { value: "88" } });
  expect(screen.getByDisplayValue("88")).toBeInTheDocument();
});
`;
  return {
    app,
    css: sharedCss,
    test,
    summary: "Implemented a supplier scorecard with vendor comparison, risk flags, and editable ratings.",
    decisions: ["Used inline rating inputs to make the update flow concrete.", "Kept vendor data local for the app-builder fixture."],
    risks: ["Ratings are not persisted beyond the current session."]
  };
}

function fleetTemplate(): TemplateOutput {
  const app = String.raw`import { useState } from "react";

type Vehicle = { id: number; unit: string; route: string; alert: string; driver: string };

const starterVehicles: Vehicle[] = [
  { id: 1, unit: "EV-204", route: "North yard", alert: "Service alert", driver: "Unassigned" },
  { id: 2, unit: "TR-118", route: "Port shuttle", alert: "Clear", driver: "Sam" },
  { id: 3, unit: "VN-041", route: "Downtown", alert: "Tire check", driver: "Unassigned" }
];

export default function App() {
  const [vehicles, setVehicles] = useState(starterVehicles);
  const [selectedDriver, setSelectedDriver] = useState("Riley");
  const alerts = vehicles.filter((vehicle) => vehicle.alert !== "Clear").length;

  function assignDriver(id: number) {
    setVehicles((current) => current.map((vehicle) => vehicle.id === id ? { ...vehicle, driver: selectedDriver } : vehicle));
  }

  return (
    <main className="app-shell">
      <div className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">Dispatch operations</p><h1>Fleet operations</h1></div>
          <div className="metric-row"><div className="metric"><strong>{vehicles.length}</strong><span>Vehicles</span></div><div className="metric"><strong>{alerts}</strong><span>Service alerts</span></div></div>
        </header>
        <section className="panel">
          <h2>Vehicle assignments</h2>
          <div className="controls"><select className="select" aria-label="Driver" value={selectedDriver} onChange={(event) => setSelectedDriver(event.target.value)}><option>Riley</option><option>Jordan</option><option>Casey</option></select></div>
          <table className="table">
            <thead><tr><th>Vehicle</th><th>Route</th><th>Alert</th><th>Driver</th><th>Action</th></tr></thead>
            <tbody>{vehicles.map((vehicle) => <tr key={vehicle.id}><td>{vehicle.unit}</td><td>{vehicle.route}</td><td><span className={vehicle.alert === "Clear" ? "badge" : "badge alert"}>{vehicle.alert}</span></td><td>{vehicle.driver}</td><td><button className="button secondary" onClick={() => assignDriver(vehicle.id)}>Assign driver</button></td></tr>)}</tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
`;
  const test = String.raw`import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";

it("shows fleet alerts and assigns a driver", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: /fleet operations/i })).toBeInTheDocument();
  expect(screen.getAllByText(/service alert/i).length).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByRole("button", { name: /assign driver/i })[0]);
  expect(screen.getAllByText(/riley/i).length).toBeGreaterThan(0);
});
`;
  return {
    app,
    css: sharedCss,
    test,
    summary: "Implemented a fleet operations screen with vehicle alerts and driver assignment.",
    decisions: ["Used a driver selector plus row actions for a complete dispatch flow.", "Kept service alerts visible in the main table for UI health checks."],
    risks: ["Driver assignments are local state only."]
  };
}
