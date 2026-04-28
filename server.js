import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🟢 Health
app.get("/", (req, res) => res.send("MCP Running"));
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
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      }
    ]
  });
});

// 🔧 Header helper
const getHeader = (req, key) =>
  req.headers[key] ||
  req.headers[key.toLowerCase()] ||
  req.headers[key.toUpperCase()];

// 🔥 MAIN HANDLER
app.post("/", async (req, res) => {
  const { method, params, id } = req.body || {};

  console.log("METHOD:", method);

  try {
    // ✅ INITIALIZE
    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {
            tools: {},
            extensions: {
              "ai.promptopinion/fhir-context": {
                scopes: [
                  { name: "patient/Patient.rs", required: true },
                  { name: "patient/Condition.rs" }
                ]
              }
            }
          }
        }
      });
    }

    // ✅ tools/list
    if (method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "get_patient_summary",
              description: "Fetch patient summary from FHIR",
              inputSchema: {
                type: "object",
                properties: {},
                required: []
              }
            }
          ]
        }
      });
    }

    // ✅ ignore notifications
    if (method === "notifications/initialized") {
      return res.json({ jsonrpc: "2.0", result: {} });
    }

    // ❌ only handle tool
    if (method !== "tools/call") {
      return res.json({ jsonrpc: "2.0", id, result: {} });
    }

    // 🔥 VALIDATE TOOL
    if (!params || params.name !== "get_patient_summary") {
      return res.json({
        result: {
          content: [
            { type: "text", text: "Invalid tool request" }
          ]
        }
      });
    }

    // 🔹 READ FHIR HEADERS (ONLY SOURCE OF TRUTH)
    const fhirBase = getHeader(req, "x-fhir-server-url");
    const token = getHeader(req, "x-fhir-access-token");
    const patientId = getHeader(req, "x-patient-id");

    if (!fhirBase || !token || !patientId) {
      return res.json({
        result: {
          content: [
            { type: "text", text: "Missing patient context" }
          ]
        }
      });
    }

    // 🔹 Fetch Patient
    const pRes = await fetch(`${fhirBase}/Patient/${patientId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const patient = await pRes.json();

    const name =
      (patient.name?.[0]?.given?.join(" ") || "") +
      " " +
      (patient.name?.[0]?.family || "");

    const gender = patient.gender || "Unknown";
    const dob = patient.birthDate || "Unknown";

    // 🔹 Fetch Conditions
    let conditions = [];

    const cRes = await fetch(
      `${fhirBase}/Condition?patient=${patientId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const cData = await cRes.json();

    conditions =
      cData.entry?.map(
        (c) => c.resource.code?.text || "Unknown"
      ) || [];

    // 🔥 FINAL TEXT (simple + stable)
    const finalText = `Patient Summary:

Name: ${name.trim()}
Gender: ${gender}
DOB: ${dob}
Conditions: ${
      conditions.length > 0
        ? conditions.join(", ")
        : "No known conditions"
    }`;

    console.log("FINAL TEXT:", finalText);

    // ✅ RETURN (CRITICAL FORMAT)
    return res.json({
      result: {
        content: [
          {
            type: "text",
            text: finalText
          }
        ]
      }
    });

  } catch (err) {
    console.error("ERROR:", err);

    return res.json({
      result: {
        content: [
          { type: "text", text: "Server error" }
        ]
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`MCP running on ${PORT}`);
});
