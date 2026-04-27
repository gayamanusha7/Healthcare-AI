import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🟢 Health
app.get("/", (req, res) => {
    res.send("MCP Server Running 🚀");
});

app.get("/healthz", (req, res) => {
    res.send("OK");
});

// 🟢 MCP Metadata
app.get("/.well-known/mcp", (req, res) => {
    res.json({
        name: "Patient Summary MCP",
        version: "1.0.0",
        tools: [
            {
                name: "get_patient_summary",
                description: "Fetch patient summary from FHIR",
                input_schema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            }
        ]
    });
});

// 🔥 Safe header getter
function getHeader(req, key) {
    return (
        req.headers[key] ||
        req.headers[key.toLowerCase()] ||
        req.headers[key.toUpperCase()]
    );
}

// 🔥 MAIN MCP HANDLER
app.post("/", async (req, res) => {
    const { method, params, id } = req.body;

    try {
        if (method !== "tools/call") {
            return res.json({
                jsonrpc: "2.0",
                id,
                error: { message: "Unsupported method" }
            });
        }

        if (params?.name !== "get_patient_summary") {
            return res.json({
                jsonrpc: "2.0",
                id,
                error: { message: "Unknown tool" }
            });
        }

        // 🔥 Extract headers
        const fhirBase = getHeader(req, "x-fhir-server-url");
        const token = getHeader(req, "x-fhir-access-token");
        const patientId = getHeader(req, "x-patient-id");

        console.log("📦 HEADERS:", {
            fhirBase,
            patientId
        });

        // 🚨 If no patient selected → return clean response (NO crash)
        if (!patientId) {
            return res.json({
                jsonrpc: "2.0",
                id,
                result: {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                message: "No patient selected. Please select a FHIR-backed patient."
                            })
                        }
                    ]
                }
            });
        }

        // 🚨 If FHIR base missing
        if (!fhirBase || !token) {
            return res.json({
                jsonrpc: "2.0",
                id,
                result: {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                message: "FHIR context missing"
                            })
                        }
                    ]
                }
            });
        }

        // 🔹 Fetch Patient
        let patient = {};
        try {
            const patientRes = await fetch(`${fhirBase}/Patient/${patientId}`, {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            });

            patient = await patientRes.json();
        } catch (err) {
            console.error("❌ Patient fetch error:", err.message);
        }

        const name =
            (patient.name?.[0]?.given?.join(" ") || "") +
            " " +
            (patient.name?.[0]?.family || "");

        // 🔹 Fetch Conditions
        let conditions = [];
        try {
            const condRes = await fetch(
                `${fhirBase}/Condition?patient=${patientId}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            );

            const condData = await condRes.json();

            conditions =
                condData.entry?.map(
                    (c) => c.resource.code?.text || "Unknown"
                ) || [];
        } catch (err) {
            console.error("❌ Condition fetch error:", err.message);
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
            result: {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result)
                    }
                ]
            }
        });

    } catch (error) {
        console.error("❌ SERVER ERROR:", error.message);

        return res.json({
            jsonrpc: "2.0",
            id: id || 1,
            error: {
                message: "Server error",
                details: error.message
            }
        });
    }
});

app.listen(PORT, () => {
    console.log(`MCP Server running on ${PORT}`);
});
