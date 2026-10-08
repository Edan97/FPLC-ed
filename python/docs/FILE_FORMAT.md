# UNICORN 6/7 result export format

Notes on the `.zip` written by UNICORN's **Export > Result**. Worked out from a
UNICORN 7.12.0.2623 export from an ÄKTA pure 25. Other versions are likely similar
but untested.

## Outer zip

| Member | Type | Contents |
|---|---|---|
| `Manifest.xml` | XML | List of members with `FileType` (Result, Chromatogram, DataCurve, ResultAuditTrail, AuditTrail) and CRCs |
| `Result.xml` | XML | Result name, system, folder, batch ID, state. `ResultRunInformation` values are **base64**. `ResultSearchCriteria` entries with `Name=VariableValue` hold every method variable as run (`Keyword1` name, `Keyword2` value, `Keyword3` unit) |
| `Chrom.N.Xml` | XML | Chromatogram definition: curve list, event curves (fractions, run log, injections), peak tables, layout |
| `Chrom.N_<k>_True` | nested zip | Data for one curve (see below). `<k>` is not the curve number; follow `BinaryCurvePointsFileName` in `Chrom.N.Xml` |
| `EvaluationLog.xml` | XML | Evaluation audit trail (e.g. peak integration settings) |
| `MethodData`, `SystemData`, `StrategyData`, `ColumnTypeData`, `SystemSettingData`, `InstrumentConfigurationData`, `CalibrationSettingData`, `MethodDocumentationData`, ... | nested zip | Each holds `Xml` (+ `XmlDataType`), an XML document wrapped in .NET BinaryFormatter |
| `NextFracData` | PNG | Fraction collector rack image (not a zip despite the manifest type) |

## Curve data (`Chrom.N_<k>_True`)

Nested zip with members:

- `CoordinateData.Amplitudes`: y values
- `CoordinateData.Volumes`: x values in ml (absent for some derived curves, e.g. baselines; use the source curve's axis, given by `DerivedCurveOrigin/FirstCurve/CurveNumber`)
- `*DataType`: the string `System.Single[]`

Each array is a .NET BinaryFormatter (MS-NRBF) stream:

```
offset  size  field
0       17    SerializationHeaderRecord (0x00, int32 rootId, int32 headerId, int32 major, int32 minor)
17      1     record type 0x0F (ArraySinglePrimitive)
18      4     int32 object id
22      4     int32 length  (number of points)
26      1     primitive type 0x0B (Single)
27      4*n   little-endian float32 values
27+4n   1     MessageEnd 0x0B
```

Read the length from offset 22 rather than assuming a fixed header size.

## XML blobs (`MethodData/Xml` etc.)

Same 17-byte header, then record type `0x06` (BinaryObjectString): int32 object id,
a 7-bit-encoded (LEB128) byte length, then UTF-8 XML.

## Curve metadata in `Chrom.N.Xml`

Useful per-curve elements: `Name`, `AmplitudeUnit`, `CurveDataType`, `CurveNumber`,
`AmplitudePrecision`, `DistanceBetweenPoints` and `DistanceToStartPoint`
(time spacing in min for original curves; in volume units for derived curves),
`ColumnVolume`, `CurveUVInfo` (path length; values are normalised to the nominal
path length when `IsUVValuesNormalizedToNominalUVPathLength` is true).

Curves are sampled at different rates (e.g. UV1 and system pressure every 0.1 s, Conc B
and flow every 1 s), so combining them requires resampling onto a shared axis.

## Events

`EventCurves/EventCurve` with `EventCurveType` of `Fraction`, `Logbook` (run log),
`Injection`, etc. Each event has `EventTime` (min), `EventVolume` (ml), `EventText`.
Phase starts appear in the run log as `Phase <name> (Issued) ...`.

## Method

`MethodData` contains the full `<Method>` document: `Blocks/Block` with
`BlockInstructions/BlockInstruction` (`ReadableName`, `BreakPointValue` in the block's
base unit, parameters with `ParameterReadableValue`/`ParameterUnit`, and
`CalledBlockName` for nested blocks). The block with `IsMainBlock=true` is the entry point.
