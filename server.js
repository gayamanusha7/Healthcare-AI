import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🟢 Health
app.get("/", (req, res) => res.send("MCP Server Running 🚀"));
app.get("/healthz", (req, res) => res.send("OK"));

// 🟢 MCP Metadata
app.get("/.well-known/mcp", (req, res) => {
  res.json({
    name: "Patient Summary MCP",
    version: "1.0.0",
    tools: [
      {
        name: "get_patient_summary",
        description: "Fetch patient summary from FHIR",
        input_schema: { type: "object", properties: {}, required: [] }
      }
    ]
  });
});

// 🔧 helpers
const getHeader = (req, key) =>
  req.headers[key] || req.headers[key.toLowerCase()] || req.headers[key.toUpperCase()];

// decode JWT payload safely (no verification needed for lookup)
function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// find patientId by name (given + family)
async function findPatientIdByName(fhirBase, token, given, family) {
  if (!given && !family) return null;

  // FHIR search (lenient): name=given family
  const q = encodeURIComponent([given, family].filter(Boolean).join(" "));
  const url = `${fhirBase}/Patient?name=${q}&_count=5`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await res.json();
  const entry = data.entry?.[0]?.resource;
  return entry?.id || null;
}

app.post("/", async (req, res) => {
  const { method, params, id } = req.body;

  try {
    if (method !== "tools/call") {
      return res.json({ jsonrpc: "2.0", id, error: { message: "Unsupported method" } });
    }

    if (params?.name !== "get_patient_summary") {
      return res.json({ jsonrpc: "2.0", id, error: { message: "Unknown tool" } });
    }

    const fhirBase = getHeader(req, "x-fhir-server-url");
    const token = getHeader(req, "x-fhir-access-token");
    let patientId = getHeader(req, "x-patient-id");

    console.log("📦 HEADERS:", { fhirBase, patientId });

    if (!fhirBase || !token) {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ message: "FHIR context missing" }) }]
        }
      });
    }

    // 🔥 NEW: resolve patientId if missing
    if (!patientId) {
      const payload = decodeJwtPayload(token);
      const given = payload?.given_name || "";
      const family = payload?.family_name || "";

      console.log("🔎 Resolving patient by token name:", { given, family });

      try {
        patientId = await findPatientIdByName(fhirBase, token, given, family);
      } catch (e) {
        console.error("❌ Patient search error:", e.message);
      }

      if (!patientId) {
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                message: "Patient context not attached and auto-resolution failed. Ensure patient exists in FHIR."
              })
            }]
          }
        });
      }
    }

    // 🔹 Fetch Patient
    let patient = {};
    try {
      const pRes = await fetch(`${fhirBase}/Patient/${patientId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      patient = await pRes.json();
    } catch (e) {
      console.error("❌ Patient fetch error:", e.message);
    }

    const name =
      (patient.name?.[0]?.given?.join(" ") || "") +
      " " +
      (patient.name?.[0]?.family || "");

    // 🔹 Fetch Conditions
    let conditions = [];
    try {
      const cRes = await fetch(`${fhirBase}/Condition?patient=${patientId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const cData = await cRes.json();
      conditions = cData.entry?.map(c => c.resource.code?.text || "Unknown") || [];
    } catch (e) {
      console.error("❌ Condition fetch error:", e.message);
    }

    const result = {
      patient_id: patientId,
      name: name.trim() || "Unknown",
      conditions,
      summary:
        conditions.length > 0
          ? `${name} has ${conditions.join(", ")}`
          : `${name} has no recorded conditions`
    };

    return res.json({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] }
    });

  } catch (error) {
    console.error("❌ SERVER ERROR:", error.message);
    return res.json({
      jsonrpc: "2.0",
      id: id || 1,
      error: { message: "Server error", details: error.message }
    });
  }
});

app.listen(PORT, () => {
  console.log(`MCP Server running on ${PORT}`);
});
