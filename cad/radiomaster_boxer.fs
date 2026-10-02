FeatureScript 3083;
import(path : "onshape/std/common.fs", version : "3083.0");

/*
 * RadioMaster Boxer (yellow) - parametric, posable Onshape model.
 *
 * World frame:  +X = right, +Y = up (antenna end), +Z = out of the front face (toward the pilot).
 * The upper front panel (gimbals) is the plane Z = 0. The lower panel (screen) folds back
 * 5 degrees below Y = FOLD_Y. Body: 178 W x 156 H x 44 D mm, grips to 62 mm, overall ~ 235 x 178 x 77 mm
 * (antenna up / grips / sticks), matching the published Boxer envelope.
 *
 * Every control is its own named part, posed by the feature parameters, and carries a mate
 * connector at its pivot (Z axis = motion axis) with a matching connector on the Front Shell,
 * so the Part Studio can also be dropped into an Assembly and driven with revolute/slider mates.
 */

// ---------------------------------------------------------------- constants (mm)
const FOLD_Y = -17;            // crease between upper (gimbal) and lower (screen) panels
const TILT = 5 * degree;       // lower panel lean-back
const BODY_D = 44;             // shell depth (front face to back face)
const SPLIT_Z = -27;           // front / rear shell parting plane
const TOP_Z = -17;             // depth of the top-edge controls (switches, pots, antenna)
const GIMBAL_X = 51.5;
const GIMBAL_Y = 22;

const YELLOW = color(1.0, 0.78, 0.07);
const YELLOW_GRIP = color(0.97, 0.72, 0.05);
const BLACK = color(0.07, 0.07, 0.08);
const DARK = color(0.17, 0.17, 0.19);
const SILVER = color(0.80, 0.81, 0.83);
const GREY_BTN = color(0.60, 0.62, 0.66);
const LCD_GREEN = color(0.62, 0.66, 0.58);
const LED_WHITE = color(0.86, 0.90, 0.95);
const GOLD = color(0.85, 0.68, 0.25);

const STICK_BOUNDS = { (degree) : [-25, 0, 25] } as AngleBoundSpec;
const THROTTLE_BOUNDS = { (degree) : [-25, -25, 25] } as AngleBoundSpec;
const POT_BOUNDS = { (degree) : [-150, 0, 150] } as AngleBoundSpec;
const WHEEL_BOUNDS = { (degree) : [-360, 0, 360] } as AngleBoundSpec;
const FOLD_BOUNDS = { (degree) : [0, 0, 90] } as AngleBoundSpec;
const SWIVEL_BOUNDS = { (degree) : [-90, 0, 90] } as AngleBoundSpec;
const LANYARD_BOUNDS = { (degree) : [0, 70, 110] } as AngleBoundSpec;

// ---------------------------------------------------------------- control states
export enum BoxerToggle2
{
    annotation { "Name" : "Up (away from you)" }
    UP,
    annotation { "Name" : "Down (toward you)" }
    DOWN
}

export enum BoxerToggle3
{
    annotation { "Name" : "Up (away from you)" }
    UP,
    annotation { "Name" : "Middle" }
    MID,
    annotation { "Name" : "Down (toward you)" }
    DOWN
}

export enum BoxerTrim
{
    annotation { "Name" : "Centre" }
    CENTER,
    annotation { "Name" : "+ (up / right)" }
    PLUS,
    annotation { "Name" : "- (down / left)" }
    MINUS
}

export enum BoxerButton
{
    annotation { "Name" : "None" }
    NONE,
    annotation { "Name" : "Power" }
    POWER,
    annotation { "Name" : "SYS" }
    SYS,
    annotation { "Name" : "MDL" }
    MDL,
    annotation { "Name" : "RTN" }
    RTN,
    annotation { "Name" : "PAGE <" }
    PAGE_PREV,
    annotation { "Name" : "PAGE >" }
    PAGE_NEXT,
    annotation { "Name" : "TELE" }
    TELE,
    annotation { "Name" : "Position 1" }
    P1,
    annotation { "Name" : "Position 2" }
    P2,
    annotation { "Name" : "Position 3" }
    P3,
    annotation { "Name" : "Position 4" }
    P4,
    annotation { "Name" : "Position 5" }
    P5,
    annotation { "Name" : "Position 6" }
    P6,
    annotation { "Name" : "Scroll wheel (ENTER)" }
    WHEEL
}

// ---------------------------------------------------------------- feature
annotation { "Feature Type Name" : "RadioMaster Boxer",
        "Feature Type Description" : "Posable RadioMaster Boxer transmitter: gimbals, toggles, pots, trims, buttons, scroll wheel and antenna are separate parts with pivot mate connectors." }
export const radioMasterBoxer = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Group Name" : "Gimbals (mode 2)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Left stick X (yaw)" }
            isAngle(definition.leftX, STICK_BOUNDS);
            annotation { "Name" : "Left stick Y (throttle)" }
            isAngle(definition.leftY, THROTTLE_BOUNDS);
            annotation { "Name" : "Right stick X (roll)" }
            isAngle(definition.rightX, STICK_BOUNDS);
            annotation { "Name" : "Right stick Y (pitch)" }
            isAngle(definition.rightY, STICK_BOUNDS);
        }
        annotation { "Group Name" : "Switches", "Collapsed By Default" : false }
        {
            annotation { "Name" : "SA (2-pos)" }
            definition.sa is BoxerToggle2;
            annotation { "Name" : "SB (3-pos)" }
            definition.sb is BoxerToggle3;
            annotation { "Name" : "SC (3-pos)" }
            definition.sc is BoxerToggle3;
            annotation { "Name" : "SD (2-pos)" }
            definition.sd is BoxerToggle2;
            annotation { "Name" : "SE latched (top-left button)" }
            definition.seLatched is boolean;
            annotation { "Name" : "SF held (top-right momentary)" }
            definition.sfHeld is boolean;
            annotation { "Name" : "S1 pot" }
            isAngle(definition.s1, POT_BOUNDS);
            annotation { "Name" : "S2 pot" }
            isAngle(definition.s2, POT_BOUNDS);
        }
        annotation { "Group Name" : "Trims and buttons", "Collapsed By Default" : true }
        {
            annotation { "Name" : "T1 (right, horizontal)" }
            definition.t1 is BoxerTrim;
            annotation { "Name" : "T2 (right, vertical)" }
            definition.t2 is BoxerTrim;
            annotation { "Name" : "T3 (left, vertical)" }
            definition.t3 is BoxerTrim;
            annotation { "Name" : "T4 (left, horizontal)" }
            definition.t4 is BoxerTrim;
            annotation { "Name" : "Pressed button" }
            definition.pressed is BoxerButton;
            annotation { "Name" : "Scroll wheel rotation" }
            isAngle(definition.wheel, WHEEL_BOUNDS);
        }
        annotation { "Group Name" : "Antenna and extras", "Collapsed By Default" : true }
        {
            annotation { "Name" : "Antenna fold (back)" }
            isAngle(definition.antennaFold, FOLD_BOUNDS);
            annotation { "Name" : "Antenna swivel" }
            isAngle(definition.antennaSwivel, SWIVEL_BOUNDS);
            annotation { "Name" : "Lanyard ring lift" }
            isAngle(definition.lanyard, LANYARD_BOUNDS);
            annotation { "Name" : "Engraved labels" }
            definition.labels is boolean;
        }
    }
    {
        var cuts = [];       // tool bodies subtracted from the shell in one boolean
        var mounts = [];     // pivot frames for the Front Shell mate connectors

        // ------------------------------------------------ shell
        const body = buildShell(context, id + "shell");

        for (var s in [-1, 1])
        {
            const tag = s < 0 ? "L" : "R";
            buildGimbalSeat(context, id + ("seat" ~ tag), body, s * GIMBAL_X, GIMBAL_Y);
        }

        // ------------------------------------------------ gimbals
        var r = buildGimbal(context, id + "gimL", "L", -GIMBAL_X, GIMBAL_Y, definition.leftX, definition.leftY);
        mounts = concatenateArrays([mounts, r.mounts]);
        r = buildGimbal(context, id + "gimR", "R", GIMBAL_X, GIMBAL_Y, definition.rightX, definition.rightY);
        mounts = concatenateArrays([mounts, r.mounts]);

        // ------------------------------------------------ top edge: toggles, pots, SE / SF
        r = buildToggle(context, id + "sa", "SA", topMount(-74, TOP_Z), true, toggle2Angle(definition.sa));
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);
        r = buildToggle(context, id + "sb", "SB", topMount(-53.5, TOP_Z), true, toggle3Angle(definition.sb));
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);
        r = buildToggle(context, id + "sc", "SC", topMount(53.5, TOP_Z), false, toggle3Angle(definition.sc));
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);
        r = buildToggle(context, id + "sd", "SD", topMount(74, TOP_Z), false, toggle2Angle(definition.sd));
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);

        r = buildPot(context, id + "s1", "S1", topMount(-28, TOP_Z), definition.s1);
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);
        r = buildPot(context, id + "s2", "S2", topMount(28, TOP_Z), definition.s2);
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);

        r = buildTopButton(context, id + "se", "SE", topMount(-85.5, TOP_Z), definition.seLatched);
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);
        r = buildTopButton(context, id + "sf", "SF", topMount(85.5, TOP_Z), definition.sfHeld);
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);

        // ------------------------------------------------ trims
        r = buildTrim(context, id + "t1", "T1", panelCs(32, -13.5), false, definition.t1);
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);
        r = buildTrim(context, id + "t2", "T2", panelCs(13.5, 5), true, definition.t2);
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);
        r = buildTrim(context, id + "t3", "T3", panelCs(-13.5, 5), true, definition.t3);
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);
        r = buildTrim(context, id + "t4", "T4", panelCs(-32, -13.5), false, definition.t4);
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);

        // ------------------------------------------------ buttons
        const pb = definition.pressed;
        r = buildButton(context, id + "pwr", "Power Button", panelCs(0, 27.5),
            function(sk is Sketch) { skRRect(sk, "b", 0, 0, 21, 7.5, 3.75); },
            function(sk is Sketch) { skRRect(sk, "r", 0, 0, 23.6, 10, 5); },
            1.0, BLACK, pb == BoxerButton.POWER, 0.8, 0);
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);

        const sysPts = [[-8, 3.4], [8, 3.4], [5, -3.4], [-8, -3.4]];
        r = buildButton(context, id + "sys", "SYS Button", panelCs(-72.5, -22),
            function(sk is Sketch) { skPoly(sk, "b", sysPts); },
            function(sk is Sketch) { skPoly(sk, "r", scalePts(sysPts, 1.15, 1.33)); },
            1.2, BLACK, pb == BoxerButton.SYS, 0.6, 1.2);
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);
        const mdlPts = mirrorPts(sysPts);
        r = buildButton(context, id + "mdl", "MDL Button", panelCs(72.5, -22),
            function(sk is Sketch) { skPoly(sk, "b", mdlPts); },
            function(sk is Sketch) { skPoly(sk, "r", scalePts(mdlPts, 1.15, 1.33)); },
            1.2, BLACK, pb == BoxerButton.MDL, 0.6, 1.2);
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);

        const navNames = ["RTN", "PAGE PREV", "PAGE NEXT", "TELE"];
        const navEnums = [BoxerButton.RTN, BoxerButton.PAGE_PREV, BoxerButton.PAGE_NEXT, BoxerButton.TELE];
        const navY = [-31.4, -41.1, -50.7, -60.4];
        for (var i = 0; i < 4; i += 1)
        {
            r = buildButton(context, id + ("nav" ~ i), navNames[i] ~ " Button", panelCs(-61.5, navY[i]),
                function(sk is Sketch) { skRRect(sk, "b", 0, 0, 15, 5.6, 2.8); },
                function(sk is Sketch) { skRRect(sk, "r", 0, 0, 16.8, 7.4, 3.7); },
                1.2, BLACK, pb == navEnums[i], 0.6, 0);
            cuts = concatenateArrays([cuts, r.cuts]);
            mounts = concatenateArrays([mounts, r.mounts]);
        }

        const posEnums = [BoxerButton.P1, BoxerButton.P2, BoxerButton.P3, BoxerButton.P4, BoxerButton.P5, BoxerButton.P6];
        for (var i = 0; i < 6; i += 1)
        {
            r = buildButton(context, id + ("pos" ~ i), "Position Button " ~ (i + 1), panelCs(-34.25 + 13.7 * i, -22.9),
                function(sk is Sketch) { skRRect(sk, "b", 0, 0, 9.2, 4, 2); },
                function(sk is Sketch) { skRRect(sk, "r", 0, 0, 10.8, 5.6, 2.8); },
                0.9, GREY_BTN, pb == posEnums[i], 0.5, 0);
            cuts = concatenateArrays([cuts, r.cuts]);
            mounts = concatenateArrays([mounts, r.mounts]);
        }

        // ------------------------------------------------ screen, wheel, LED, grille, lanyard
        r = buildScreen(context, id + "scr", panelCs(0, -52.5));
        cuts = concatenateArrays([cuts, r.cuts]);

        r = buildWheel(context, id + "whl", panelCs(61.5, -47.1), definition.wheel, pb == BoxerButton.WHEEL);
        cuts = concatenateArrays([cuts, r.cuts]);
        mounts = concatenateArrays([mounts, r.mounts]);

        r = buildLed(context, id + "led", panelCs(0, 20));
        cuts = concatenateArrays([cuts, r.cuts]);

        r = buildGrilleCuts(context, id + "grl", panelCs(0, 45.3));
        cuts = concatenateArrays([cuts, r.cuts]);

        r = buildLanyard(context, id + "lny", panelCs(0, -4), definition.lanyard);
        mounts = concatenateArrays([mounts, r.mounts]);

        // ------------------------------------------------ top antenna, rear features, ports
        r = buildAntenna(context, id + "ant", definition.antennaFold, definition.antennaSwivel);
        mounts = concatenateArrays([mounts, r.mounts]);

        r = buildRear(context, id + "rear");
        cuts = concatenateArrays([cuts, r.cuts]);

        r = buildPorts(context, id + "port");
        cuts = concatenateArrays([cuts, r.cuts]);

        // ------------------------------------------------ one boolean for every recess
        cutBody(context, id + "recesses", body, qUnion(cuts));

        // ------------------------------------------------ raised logo + engraved labels
        buildMarkings(context, id + "mark", body, definition.labels);

        // ------------------------------------------------ removable grips (conform to the shell)
        buildGrips(context, id + "grip", body);

        // ------------------------------------------------ split into front / rear shells
        opPattern(context, id + "rearCopy", { "entities" : body, "transforms" : [identityTransform()], "instanceNames" : ["rear"] });
        const rearShell = qCreatedBy(id + "rearCopy", EntityType.BODY);
        fCuboid(context, id + "keepFront", { "corner1" : pt(-130, -130, SPLIT_Z), "corner2" : pt(130, 160, 60) });
        fCuboid(context, id + "keepRear", { "corner1" : pt(-130, -130, -90), "corner2" : pt(130, 160, SPLIT_Z) });
        cutBody(context, id + "splitF", body, qCreatedBy(id + "keepRear", EntityType.BODY));
        cutBody(context, id + "splitR", rearShell, qCreatedBy(id + "keepFront", EntityType.BODY));
        finishPart(context, body, "Front Shell", YELLOW);
        finishPart(context, rearShell, "Rear Shell", YELLOW);

        // ------------------------------------------------ matching pivot connectors on the Front Shell
        for (var i = 0; i < size(mounts); i += 1)
        {
            opMateConnector(context, id + ("mount" ~ i), { "coordSystem" : mounts[i], "owner" : body });
        }

        // ------------------------------------------------ tidy up construction sketches
        opDeleteBodies(context, id + "cleanup", { "entities" : qSketchFilter(qCreatedBy(id, EntityType.BODY), SketchObject.YES) });

        const parts = qBodyType(qCreatedBy(id, EntityType.BODY), BodyType.SOLID);
        reportFeatureInfo(context, id, "RadioMaster Boxer: " ~ size(evaluateQuery(context, parts)) ~ " parts, " ~ size(mounts) ~ " pivots");
    }, {
            "leftX" : 0 * degree, "leftY" : -25 * degree, "rightX" : 0 * degree, "rightY" : 0 * degree,
            "sa" : BoxerToggle2.UP, "sb" : BoxerToggle3.UP, "sc" : BoxerToggle3.UP, "sd" : BoxerToggle2.UP,
            "seLatched" : false, "sfHeld" : false, "s1" : 0 * degree, "s2" : 0 * degree,
            "t1" : BoxerTrim.CENTER, "t2" : BoxerTrim.CENTER, "t3" : BoxerTrim.CENTER, "t4" : BoxerTrim.CENTER,
            "pressed" : BoxerButton.NONE, "wheel" : 0 * degree,
            "antennaFold" : 0 * degree, "antennaSwivel" : 0 * degree, "lanyard" : 70 * degree, "labels" : true
        });

// ================================================================ shell

function buildShell(context is Context, fid is Id) returns Query
{
    // Front-view outline: vertical upper sides, slight taper below the waist, big corner radii.
    const outline = sketchExtrude(context, fid + "outl", plane(pt(0, 0, -50), vector(0, 0, 1), vector(1, 0, 0)), 56,
        function(sk is Sketch)
        {
            skPoly(sk, "o", [[-89, 78], [89, 78], [89, 0], [86.5, -78], [-86.5, -78], [-89, 0]]);
        }, true);
    filletEdges(context, fid + "fTop", qUnion([edgeAt(outline, pt(-89, 78, -20)), edgeAt(outline, pt(89, 78, -20))]), 26);
    filletEdges(context, fid + "fBot", qUnion([edgeAt(outline, pt(-86.5, -78, -20)), edgeAt(outline, pt(86.5, -78, -20))]), 32);
    filletEdges(context, fid + "fWaist", qUnion([edgeAt(outline, pt(-89, 0, -20)), edgeAt(outline, pt(89, 0, -20))]), 150);

    // Side profile: flat upper face, lower face leaning back from the fold, flat back.
    const zLow = -(90 + FOLD_Y) * tan(TILT);
    const prof = sketchExtrude(context, fid + "prof", plane(pt(-100, 0, 0), vector(1, 0, 0), vector(0, 1, 0)), 200,
        function(sk is Sketch)
        {
            skPoly(sk, "p", [[90, 0], [FOLD_Y, 0], [-90, zLow], [-90, -BODY_D], [90, -BODY_D]]);
        }, true);

    opBoolean(context, fid + "isect", { "tools" : qUnion([outline, prof]), "operationType" : BooleanOperationType.INTERSECTION });
    const body = qCreatedBy(fid + "isect", EntityType.BODY);

    // Soft front perimeter (both panels, not the fold) and a fuller back edge.
    const eU = faceEdges(faceAt(body, pt(0, 40, 0)));
    const eL = faceEdges(faceAt(body, pt(0, -50, -(FOLD_Y + 50) * tan(TILT))));
    filletEdges(context, fid + "fFront", qSubtraction(qUnion([eU, eL]), qIntersection([eU, eL])), 6);
    filletEdges(context, fid + "fBack", faceEdges(faceAt(body, pt(0, 0, -BODY_D))), 9);
    return body;
}

// Raised bezel ring around each gimbal plus the gimbal bore.
function buildGimbalSeat(context is Context, fid is Id, body is Query, cx is number, cy is number)
{
    const cs = coordSystem(pt(cx, cy, 0), vector(1, 0, 0), vector(0, 0, 1));
    const ring = localExtrude(context, fid + "ring", cs, -0.3, 1.8, function(sk is Sketch)
        {
            skCircle(sk, "o", { "center" : v2(0, 0), "radius" : 30.5 * millimeter });
            skCircle(sk, "i", { "center" : v2(0, 0), "radius" : 27 * millimeter });
        }, true);
    unite(context, fid + "u", body, ring);
    const bore = lcyl(context, fid + "bore", cs, 0, 0, 3, -16, 27);
    cutBody(context, fid + "c", body, bore);
    filletEdges(context, fid + "fb", edgeAt(body, lp(cs, 30.5, 0, 0)), 0.8);
    filletEdges(context, fid + "ft", faceEdges(faceAt(body, lp(cs, 28.75, 0, 1.8))), 0.6);
}

// ================================================================ gimbal

function buildGimbal(context is Context, fid is Id, tag is string, cx is number, cy is number,
    roll is ValueWithUnits, pitch is ValueWithUnits) returns map
{
    const cs = coordSystem(pt(cx, cy, 0), vector(1, 0, 0), vector(0, 0, 1));
    const P = lp(cs, 0, 0, -12.5);
    const csP = coordSystem(P, vector(1, 0, 0), vector(0, 0, 1));

    // Housing / face plate with the stick window and four screw sockets.
    const housing = lcyl(context, fid + "hs", cs, 0, 0, -16, -3.2, 26.6);
    filletEdges(context, fid + "hf", edgeAt(housing, lp(cs, 26.6, 0, -3.2)), 0.6);
    const win = localExtrude(context, fid + "win", cs, -2.5, -10, function(sk is Sketch)
        {
            skRRect(sk, "w", 0, 0, 34, 24, 4);
        }, true);
    const screws = localExtrude(context, fid + "scr", cs, -2.5, -4, function(sk is Sketch)
        {
            for (var i = 0; i < 4; i += 1)
            {
                const a = (45 + 90 * i) * degree;
                skCircle(sk, "s" ~ i, { "center" : v2(22 * cos(a), 22 * sin(a)), "radius" : 1.4 * millimeter });
            }
        }, true);
    const clear = lcyl(context, fid + "clr", cs, 0, 0, -15.5, -9.5, 6.5); // swing clearance below the pivot (0.5 mm floor)
    cutBody(context, fid + "hc", housing, qUnion([win, screws, clear]));
    finishPart(context, housing, "Gimbal " ~ tag ~ " Housing", BLACK);

    // Yoke: arc cradle about the X axis with a slot for the stick.
    const yoke = sketchExtrude(context, fid + "yk", plane(P - vector(15, 0, 0) * millimeter, vector(1, 0, 0), vector(0, 1, 0)), 30,
        function(sk is Sketch)
        {
            const ro = 9.5;
            const ri = 7.5;
            const a0 = 50 * degree;
            const a1 = 130 * degree;
            skArc(sk, "o", { "start" : v2(ro * cos(a0), ro * sin(a0)), "mid" : v2(0, ro), "end" : v2(ro * cos(a1), ro * sin(a1)) });
            skLineSegment(sk, "l1", { "start" : v2(ro * cos(a1), ro * sin(a1)), "end" : v2(ri * cos(a1), ri * sin(a1)) });
            skArc(sk, "i", { "start" : v2(ri * cos(a1), ri * sin(a1)), "mid" : v2(0, ri), "end" : v2(ri * cos(a0), ri * sin(a0)) });
            skLineSegment(sk, "l2", { "start" : v2(ri * cos(a0), ri * sin(a0)), "end" : v2(ro * cos(a0), ro * sin(a0)) });
        }, true);
    const yslot = localExtrude(context, fid + "ys", csP, 12, 0, function(sk is Sketch)
        {
            skRRect(sk, "s", 0, 0, 22, 4.8, 2.4);
        }, true);
    cutBody(context, fid + "ysc", yoke, yslot);
    finishPart(context, yoke, "Gimbal " ~ tag ~ " Yoke", SILVER);

    // Stick: shaft + grooved stick end.
    const shaft = lcyl(context, fid + "sh", csP, 0, 0, -1.5, 19.5, 2.0);
    const knob = lcyl(context, fid + "kn", csP, 0, 0, 18.5, 31.5, 4.0);
    unite(context, fid + "su", knob, shaft);
    filletEdges(context, fid + "kf1", edgeAt(knob, lp(csP, 4, 0, 31.5)), 0.9);
    filletEdges(context, fid + "kf2", edgeAt(knob, lp(csP, 4, 0, 18.5)), 0.5);
    const gsk = newSketchOnPlane(context, fid + "gsk", { "sketchPlane" : plane(P, vector(0, -1, 0), vector(1, 0, 0)) });
    for (var k = 0; k < 3; k += 1)
    {
        skRRect(gsk, "g" ~ k, 4.1, 22.5 + 3 * k, 1.1, 0.7, 0);
    }
    skSolve(gsk);
    opRevolve(context, fid + "grv", { "entities" : qSketchRegion(fid + "gsk", true), "axis" : line(P, vector(0, 0, 1)), "angleForward" : 360 * degree });
    cutBody(context, fid + "gc", knob, qCreatedBy(fid + "grv", EntityType.BODY));
    finishPart(context, knob, "Gimbal " ~ tag ~ " Stick", SILVER);

    // Pivot connectors, then pose: yoke follows Y (pitch / throttle), stick follows both.
    opMateConnector(context, fid + "mcH", { "coordSystem" : csP, "owner" : housing });
    const yokeCs = coordSystem(P, vector(0, 1, 0), vector(1, 0, 0));
    const yokeT = rotationAround(line(P, vector(1, 0, 0)), -pitch);
    const stickT = yokeT * rotationAround(line(P, vector(0, 1, 0)), roll);
    poseWithMc(context, fid + "pY", yoke, yokeCs, yokeT);
    poseWithMc(context, fid + "pS", knob, csP, stickT);
    return { "mounts" : [csP] };
}

// ================================================================ top-edge controls

function buildToggle(context is Context, fid is Id, tag is string, cs is CoordSystem, blade is boolean, ang is ValueWithUnits) returns map
{
    const yAx = yAxisOf(cs);
    const well = lcyl(context, fid + "well", cs, 0, 0, 1.0, -1.2, 5.6);

    // Threaded bushing + hex nut (silver), hollow so the lever can rock.
    const bush = lcyl(context, fid + "bu", cs, 0, 0, -1.2, 5.5, 3.0);
    const nut = localExtrude(context, fid + "nut", cs, -1.2, 0.9, function(sk is Sketch)
        {
            skRegularPolygon(sk, "h", { "center" : v2(0, 0), "firstVertex" : v2(4.62, 0), "sides" : 6 });
        }, true);
    unite(context, fid + "bnu", bush, nut);
    const bore = lcyl(context, fid + "bb", cs, 0, 0, 6, 2.5, 2.3);
    cutBody(context, fid + "bbc", bush, bore);
    finishPart(context, bush, tag ~ " Bushing", SILVER);

    // Lever: flat paddle (SA / SB) or tapered round bat (SC / SD).
    var lever;
    if (blade)
    {
        lever = lcyl(context, fid + "lsh", cs, 0, 0, 3.0, 8.0, 1.5);
        const paddle = sketchExtrude(context, fid + "lbl", plane(lp(cs, 0, 1.1, 0), yAx * -1, cs.xAxis), 2.2,
            function(sk is Sketch)
            {
                skRRect(sk, "b", 0, 13.5, 4.8, 12, 2.0);
            }, true);
        unite(context, fid + "lu", lever, paddle);
    }
    else
    {
        fCone(context, fid + "lcn", { "bottomCenter" : lp(cs, 0, 0, 3.0), "topCenter" : lp(cs, 0, 0, 17.0),
                    "bottomRadius" : 1.25 * millimeter, "topRadius" : 2.3 * millimeter });
        lever = qCreatedBy(fid + "lcn", EntityType.BODY);
        filletEdges(context, fid + "lcf", edgeAt(lever, lp(cs, 2.3, 0, 17.0)), 1.1);
    }
    finishPart(context, lever, tag ~ " Lever", SILVER);

    const pivot = lp(cs, 0, 0, 4);
    const pivotCs = coordSystem(pivot, yAx, cs.xAxis);
    poseWithMc(context, fid + "pose", lever, pivotCs, rotationAround(line(pivot, cs.xAxis), ang));
    return { "cuts" : [well], "mounts" : [pivotCs] };
}

function buildPot(context is Context, fid is Id, tag is string, cs is CoordSystem, ang is ValueWithUnits) returns map
{
    const well = lcyl(context, fid + "well", cs, 0, 0, 1.0, -0.8, 7.2);
    const knob = lcyl(context, fid + "kn", cs, 0, 0, -0.8, 8.0, 5.8);
    filletEdges(context, fid + "kf", edgeAt(knob, lp(cs, 5.8, 0, 8.0)), 0.8);

    // Pointer groove on the cap + knurl flutes around the skirt.
    const ptr = localExtrude(context, fid + "ptr", cs, 8.6, 7.4, function(sk is Sketch)
        {
            skRRect(sk, "p", 0, 3.4, 1.0, 3.6, 0.5);
        }, true);
    const flute = lcyl(context, fid + "fl", cs, 6.05, 0, -0.8, 6.4, 0.55);
    var tfs = [];
    var names = [];
    for (var i = 1; i < 24; i += 1)
    {
        tfs = append(tfs, rotationAround(line(cs.origin, cs.zAxis), i * 15 * degree));
        names = append(names, "f" ~ i);
    }
    opPattern(context, fid + "flp", { "entities" : flute, "transforms" : tfs, "instanceNames" : names });
    cutBody(context, fid + "kc", knob, qUnion([ptr, flute, qCreatedBy(fid + "flp", EntityType.BODY)]));
    finishPart(context, knob, tag ~ " Knob", BLACK);

    poseWithMc(context, fid + "pose", knob, cs, rotationAround(line(cs.origin, cs.zAxis), ang));
    return { "cuts" : [well], "mounts" : [cs] };
}

function buildTopButton(context is Context, fid is Id, tag is string, cs is CoordSystem, pressed is boolean) returns map
{
    const well = lcyl(context, fid + "well", cs, 0, 0, 1.0, -2.6, 4.9);
    const cap = lcyl(context, fid + "cap", cs, 0, 0, -1.8, 1.3, 4.2);
    filletEdges(context, fid + "cf", edgeAt(cap, lp(cs, 4.2, 0, 1.3)), 0.9);
    finishPart(context, cap, tag ~ " Button", BLACK);
    poseWithMc(context, fid + "pose", cap, cs, pressed ? transform(cs.zAxis * -0.8 * millimeter) : identityTransform());
    return { "cuts" : [well], "mounts" : [cs] };
}

// ================================================================ front panel controls

function buildTrim(context is Context, fid is Id, tag is string, cs is CoordSystem, vertical is boolean, state is BoxerTrim) returns map
{
    const yAx = yAxisOf(cs);
    const sw = vertical ? 5.8 : 14;
    const sh = vertical ? 14 : 5.8;
    const lw = vertical ? 3.6 : 8.4;
    const lh = vertical ? 8.4 : 3.6;
    const slot = localExtrude(context, fid + "slot", cs, 0.6, -4.6, function(sk is Sketch) { skRRect(sk, "s", 0, 0, sw, sh, 1.4); }, true);
    const lever = localExtrude(context, fid + "lv", cs, -3.6, 2.4, function(sk is Sketch) { skRRect(sk, "l", 0, 0, lw, lh, 1.0); }, true);
    filletEdges(context, fid + "lf", faceEdges(faceAt(lever, lp(cs, 0, 0, 2.4))), 0.6);
    const ribs = localExtrude(context, fid + "rib", cs, 2.6, 2.1, function(sk is Sketch)
        {
            for (var k in [-2, 0, 2])
            {
                if (vertical)
                    skRRect(sk, "r" ~ (k + 2), 0, k, 6, 0.5, 0);
                else
                    skRRect(sk, "r" ~ (k + 2), k, 0, 0.5, 6, 0);
            }
        }, true);
    cutBody(context, fid + "rc", lever, ribs);
    finishPart(context, lever, tag ~ " Trim", DARK);

    const sgn = state == BoxerTrim.PLUS ? 1 : (state == BoxerTrim.MINUS ? -1 : 0);
    const pivot = lp(cs, 0, 0, -3.6);
    const axis = vertical ? cs.xAxis : yAx;
    const ang = vertical ? -sgn * 10 * degree : sgn * 10 * degree;
    const pivotCs = coordSystem(pivot, vertical ? yAx : cs.xAxis * -1, axis);
    poseWithMc(context, fid + "pose", lever, pivotCs, rotationAround(line(pivot, axis), ang));
    return { "cuts" : [slot], "mounts" : [pivotCs] };
}

// Generic plunger button in a recess; pressed = 0.8 mm travel along the panel normal.
function buildButton(context is Context, fid is Id, name is string, cs is CoordSystem, btnDraw is function, recDraw is function,
    h is number, col is Color, pressed is boolean, topR is number, cornerR is number) returns map
{
    const rec = localExtrude(context, fid + "rec", cs, 0.6, -2.2, recDraw, true);
    const btn = localExtrude(context, fid + "btn", cs, -1.4, h, btnDraw, true);
    if (cornerR > 0)
    {
        const capEdges = qUnion([faceEdges(faceAt(btn, lp(cs, 0, 0, h))), faceEdges(faceAt(btn, lp(cs, 0, 0, -1.4)))]);
        filletEdges(context, fid + "cr", qSubtraction(qOwnedByBody(btn, EntityType.EDGE), capEdges), cornerR);
    }
    filletEdges(context, fid + "tr", faceEdges(faceAt(btn, lp(cs, 0, 0, h))), topR);
    finishPart(context, btn, name, col);
    poseWithMc(context, fid + "pose", btn, cs, pressed ? transform(cs.zAxis * -0.8 * millimeter) : identityTransform());
    return { "cuts" : [rec], "mounts" : [cs] };
}

function buildScreen(context is Context, fid is Id, cs is CoordSystem) returns map
{
    const rec = localExtrude(context, fid + "rec", cs, 0.6, -2.2, function(sk is Sketch) { skRRect(sk, "r", 0, 0, 82.1, 37.1, 3.6); }, true);
    const bezel = localExtrude(context, fid + "bz", cs, -2.2, -0.15, function(sk is Sketch) { skRRect(sk, "b", 0, 0, 81.5, 36.5, 3.3); }, true);
    filletEdges(context, fid + "bf", faceEdges(faceAt(bezel, lp(cs, 30, 0, -0.15))), 0.5);
    const win = localExtrude(context, fid + "win", cs, 0.5, -1.4, function(sk is Sketch) { skRRect(sk, "w", -2.8, 0.5, 64.6, 26.6, 1.2); }, true);
    cutBody(context, fid + "wc", bezel, win);
    finishPart(context, bezel, "Screen Bezel", BLACK);
    const lcd = localExtrude(context, fid + "lcd", cs, -1.4, -1.0, function(sk is Sketch) { skRRect(sk, "l", -2.8, 0.5, 64.4, 26.4, 1.1); }, true);
    finishPart(context, lcd, "LCD 128x64", LCD_GREEN);
    return { "cuts" : [rec] };
}

function buildWheel(context is Context, fid is Id, cs is CoordSystem, ang is ValueWithUnits, pressed is boolean) returns map
{
    const yAx = yAxisOf(cs);
    const rec = localExtrude(context, fid + "rec", cs, 0.6, -20.5, function(sk is Sketch) { skRRect(sk, "r", 0, 0, 11.8, 25.6, 2.6); }, true);
    const C = lp(cs, 0, 0, -8.4);
    const wheel = sketchExtrude(context, fid + "wh", plane(lp(cs, -4.8, 0, -8.4), cs.xAxis, yAx), 9.6, function(sk is Sketch)
        {
            skCircle(sk, "c", { "center" : v2(0, 0), "radius" : 11 * millimeter });
        }, true);
    filletEdges(context, fid + "wf", qOwnedByBody(wheel, EntityType.EDGE), 0.8);
    const rib = sketchExtrude(context, fid + "rb", plane(lp(cs, -5.8, 0, -8.4), cs.xAxis, yAx), 11.6, function(sk is Sketch)
        {
            skRRect(sk, "g", 0, 11, 1.3, 1.8, 0);
        }, true);
    var tfs = [];
    var names = [];
    for (var i = 1; i < 24; i += 1)
    {
        tfs = append(tfs, rotationAround(line(C, cs.xAxis), i * 15 * degree));
        names = append(names, "g" ~ i);
    }
    opPattern(context, fid + "rbp", { "entities" : rib, "transforms" : tfs, "instanceNames" : names });
    cutBody(context, fid + "wc", wheel, qUnion([rib, qCreatedBy(fid + "rbp", EntityType.BODY)]));
    finishPart(context, wheel, "Scroll Wheel", BLACK);

    const axleCs = coordSystem(C, yAx, cs.xAxis);
    var T = rotationAround(line(C, cs.xAxis), ang);
    if (pressed)
        T = transform(cs.zAxis * -0.8 * millimeter) * T;
    poseWithMc(context, fid + "pose", wheel, axleCs, T);
    return { "cuts" : [rec], "mounts" : [axleCs] };
}

function buildLed(context is Context, fid is Id, cs is CoordSystem) returns map
{
    const rec = localExtrude(context, fid + "rec", cs, 0.6, -1.0, function(sk is Sketch) { skRRect(sk, "r", 0, 0, 12.4, 2.4, 1.2); }, true);
    const bar = localExtrude(context, fid + "bar", cs, -1.0, -0.1, function(sk is Sketch) { skRRect(sk, "b", 0, 0, 12, 2, 1); }, true);
    finishPart(context, bar, "Status LED Bar", LED_WHITE);
    return { "cuts" : [rec] };
}

// Speaker grille: pill recess, hex hole field, plate for the BOXER mark (added in buildMarkings).
function buildGrilleCuts(context is Context, fid is Id, cs is CoordSystem) returns map
{
    const rec = localExtrude(context, fid + "rec", cs, 0.6, -0.8, function(sk is Sketch) { skRRect(sk, "r", 0, 0, 33, 13, 6.5); }, true);
    const holes = localExtrude(context, fid + "hol", cs, -0.5, -3.0, function(sk is Sketch)
        {
            var n = 0;
            for (var j = -2; j <= 2; j += 1)
            {
                const y = j * 2.1;
                const x0 = (j % 2 == 0) ? 0 : 1.2;
                for (var i = -7; i <= 7; i += 1)
                {
                    const x = x0 + i * 2.4;
                    const dx = max(abs(x) - 10, 0);
                    const inside = dx * dx + y * y <= 4.3 * 4.3;
                    const plate = abs(x) < 8.6 && abs(y) < 2.4;
                    if (inside && !plate)
                    {
                        skCircle(sk, "h" ~ n, { "center" : v2(x, y), "radius" : 0.6 * millimeter });
                        n += 1;
                    }
                }
            }
        }, false);
    return { "cuts" : [rec, holes] };
}

function buildLanyard(context is Context, fid is Id, cs is CoordSystem, lift is ValueWithUnits) returns map
{
    const yAx = yAxisOf(cs);
    const boss = lcyl(context, fid + "bs", cs, 0, 0, 0, 1.6, 3.2);
    filletEdges(context, fid + "bf", edgeAt(boss, lp(cs, 3.2, 0, 1.6)), 0.5);
    finishPart(context, boss, "Lanyard Boss", SILVER);

    const H = lp(cs, 0, 0, 2.6);
    const Rc = lp(cs, 0, -4.6, 2.6);
    const sk = newSketchOnPlane(context, fid + "sk", { "sketchPlane" : plane(Rc, cs.xAxis, yAx) });
    skCircle(sk, "c", { "center" : v2(4.6, 0), "radius" : 0.9 * millimeter });
    skSolve(sk);
    opRevolve(context, fid + "rv", { "entities" : qSketchRegion(fid + "sk", true), "axis" : line(Rc, cs.zAxis), "angleForward" : 360 * degree });
    const ring = qCreatedBy(fid + "rv", EntityType.BODY);
    finishPart(context, ring, "Lanyard Ring", SILVER);
    const hingeCs = coordSystem(H, yAx, cs.xAxis);
    poseWithMc(context, fid + "pose", ring, hingeCs, rotationAround(line(H, cs.xAxis), -lift));
    return { "mounts" : [hingeCs] };
}

// ================================================================ antenna

function buildAntenna(context is Context, fid is Id, fold is ValueWithUnits, swivel is ValueWithUnits) returns map
{
    const zA = TOP_Z;
    const Q = pt(0, 86, zA);

    // Fixed clevis base on the top edge.
    const base = sketchExtrude(context, fid + "base", plane(pt(0, 78, zA), vector(0, 1, 0), vector(1, 0, 0)), 8,
        function(sk is Sketch)
        {
            skRRect(sk, "b", 0, 0, 15, 12, 3);
        }, true);
    filletEdges(context, fid + "bf", faceEdges(faceAt(base, pt(0, 86, zA))), 1.5);
    fCuboid(context, fid + "gap", { "corner1" : pt(-4.3, 81, zA - 7), "corner2" : pt(4.3, 90, zA + 7) });
    cutBody(context, fid + "gc", base, qCreatedBy(fid + "gap", EntityType.BODY));
    finishPart(context, base, "Antenna Base", BLACK);

    // Hinge knuckle (folds) and antenna mast + T paddle (folds and swivels).
    const knuckle = lcyl(context, fid + "kn", coordSystem(Q, vector(0, 1, 0), vector(1, 0, 0)), 0, 0, -4.1, 4.1, 4.2);
    const collar = lcyl(context, fid + "co", coordSystem(Q, vector(1, 0, 0), vector(0, 1, 0)), 0, 0, 2, 9, 3.4);
    unite(context, fid + "ku", knuckle, collar);
    finishPart(context, knuckle, "Antenna Hinge", BLACK);

    const mast = lcyl(context, fid + "ms", coordSystem(Q, vector(1, 0, 0), vector(0, 1, 0)), 0, 0, 9, 36, 2.7);
    const paddle = sketchExtrude(context, fid + "pd", plane(pt(0, 0, zA - 1.8), vector(0, 0, 1), vector(1, 0, 0)), 3.6,
        function(sk is Sketch)
        {
            skRRect(sk, "p", 0, 124, 62, 8, 4);
        }, true);
    filletEdges(context, fid + "pf", qUnion([faceEdges(faceAt(paddle, pt(0, 124, zA + 1.8))), faceEdges(faceAt(paddle, pt(0, 124, zA - 1.8)))]), 1.2);
    unite(context, fid + "mu", paddle, mast);
    finishPart(context, paddle, "Antenna", BLACK);

    const hingeCs = coordSystem(Q, vector(0, 1, 0), vector(1, 0, 0));
    const mastCs = coordSystem(Q, vector(1, 0, 0), vector(0, 1, 0));
    const foldT = rotationAround(line(Q, vector(1, 0, 0)), -fold);
    poseWithMc(context, fid + "pK", knuckle, hingeCs, foldT);
    poseWithMc(context, fid + "pA", paddle, mastCs, foldT * rotationAround(line(Q, vector(0, 1, 0)), swivel));
    return { "mounts" : [hingeCs] };
}

// ================================================================ back

function backCs(x is number, y is number) returns CoordSystem
{
    // local +z points out of the back, local +y = world -Y
    return coordSystem(pt(x, y, -BODY_D), vector(1, 0, 0), vector(0, 0, -1));
}

function buildRear(context is Context, fid is Id) returns map
{
    // Battery bay door (2S Li-ion / LiPo).
    const bcs = backCs(0, -40);
    const doorRec = localExtrude(context, fid + "drec", bcs, 1, -1.6, function(sk is Sketch) { skRRect(sk, "r", 0, 0, 72.6, 44.6, 4.3); }, true);
    const door = localExtrude(context, fid + "door", bcs, -1.6, -0.05, function(sk is Sketch) { skRRect(sk, "d", 0, 0, 72, 44, 4); }, true);
    filletEdges(context, fid + "df", faceEdges(faceAt(door, lp(bcs, 0, 0, -0.05))), 0.5);
    const notch = localExtrude(context, fid + "dn", bcs, 0.5, -0.8, function(sk is Sketch) { skRRect(sk, "n", 0, -18, 12, 3, 1.5); }, true);
    cutBody(context, fid + "dnc", door, notch);
    finishPart(context, door, "Battery Door", YELLOW);

    // JR module bay with 5-pin header.
    const jcs = backCs(0, 32);
    const bay = localExtrude(context, fid + "bay", jcs, 1, -8, function(sk is Sketch) { skRRect(sk, "b", 0, 0, 50, 36, 3); }, true);
    fCuboid(context, fid + "hdr", { "corner1" : pt(-7, 15.5, -BODY_D + 8), "corner2" : pt(7, 18.5, -BODY_D + 5.5) });
    finishPart(context, qCreatedBy(fid + "hdr", EntityType.BODY), "JR Bay Header", BLACK);
    for (var i = 0; i < 5; i += 1)
    {
        const x = (i - 2) * 2.54;
        fCuboid(context, fid + ("pin" ~ i), { "corner1" : pt(x - 0.32, 16.68, -BODY_D + 5.5), "corner2" : pt(x + 0.32, 17.32, -BODY_D + 1.5) });
        finishPart(context, qCreatedBy(fid + ("pin" ~ i), EntityType.BODY), "JR Pin " ~ (i + 1), GOLD);
    }

    // Fabric carry strap with two anchors across the upper back.
    for (var s in [-1, 1])
    {
        fCuboid(context, fid + ("anc" ~ (s + 1)), { "corner1" : pt(s * 29, 54, -BODY_D), "corner2" : pt(s * 37, 66, -BODY_D - 3) });
        finishPart(context, qCreatedBy(fid + ("anc" ~ (s + 1)), EntityType.BODY), "Strap Anchor", BLACK);
    }
    const strap = sketchExtrude(context, fid + "strap", plane(pt(0, 55, 0), vector(0, 1, 0), vector(1, 0, 0)), 10,
        function(sk is Sketch)
        {
            // sketch (u, v) = (X, -Z)
            const v0 = BODY_D + 3;
            skArc(sk, "o", { "start" : v2(-33, v0), "mid" : v2(0, v0 + 11.7), "end" : v2(33, v0) });
            skLineSegment(sk, "r", { "start" : v2(33, v0), "end" : v2(30.6, v0) });
            skArc(sk, "i", { "start" : v2(30.6, v0), "mid" : v2(0, v0 + 9.3), "end" : v2(-30.6, v0) });
            skLineSegment(sk, "l", { "start" : v2(-30.6, v0), "end" : v2(-33, v0) });
        }, true);
    finishPart(context, strap, "Carry Strap", DARK);

    return { "cuts" : [doorRec, bay] };
}

// USB-C (charge + data) on the bottom edge, micro-SD on the left side.
function buildPorts(context is Context, fid is Id) returns map
{
    const usb = sketchExtrude(context, fid + "usb", plane(pt(0, -79, 0), vector(0, 1, 0), vector(1, 0, 0)), 7.5,
        function(sk is Sketch)
        {
            // sketch (u, v) = (X, -Z)
            skRRect(sk, "a", -12, 20, 9.2, 3.4, 1.7);
            skRRect(sk, "b", 12, 20, 9.2, 3.4, 1.7);
        }, true);
    for (var s in [-1, 1])
    {
        fCuboid(context, fid + ("tg" ~ (s + 1)), { "corner1" : pt(s * 12 - 3.3, -76.8, -20.35), "corner2" : pt(s * 12 + 3.3, -71.6, -19.65) });
        finishPart(context, qCreatedBy(fid + ("tg" ~ (s + 1)), EntityType.BODY), "USB-C Tongue", BLACK);
    }
    fCuboid(context, fid + "sd", { "corner1" : pt(-90, 7.1, -26.5), "corner2" : pt(-83, 8.9, -13.5) });
    return { "cuts" : [usb, qCreatedBy(fid + "sd", EntityType.BODY)] };
}

function buildGrips(context is Context, fid is Id, body is Query)
{
    for (var s in [-1, 1])
    {
        const gid = fid + (s < 0 ? "L" : "R");
        const grip = sketchExtrude(context, gid + "g", plane(pt(0, 0, -62), vector(0, 0, 1), vector(1, 0, 0)), 32,
            function(sk is Sketch)
            {
                skRRect(sk, "g", s * 61, -28, 42, 76, 18);
            }, true);
        filletEdges(context, gid + "f", faceEdges(faceAt(grip, pt(s * 61, -28, -62))), 10);
        opBoolean(context, gid + "fit", { "tools" : body, "targets" : grip, "operationType" : BooleanOperationType.SUBTRACTION, "keepTools" : true });
        finishPart(context, grip, s < 0 ? "Grip L" : "Grip R", YELLOW_GRIP);
    }
}

// Raised RADIOMASTER logo, BOXER mark in the grille, engraved control legends.
function buildMarkings(context is Context, fid is Id, body is Query, labels is boolean)
{
    const logo = localExtrude(context, fid + "logo", panelCs(0, 61), -0.2, 0.45, function(sk is Sketch)
        {
            skLabel(sk, "logo", "RADIOMASTER", 0, 0, 5.6, true);
        }, true);
    const boxer = localExtrude(context, fid + "boxer", panelCs(0, 45.3), -1.0, -0.35, function(sk is Sketch)
        {
            skLabel(sk, "bx", "BOXER", 0, 0, 3.2, true);
        }, true);
    opBoolean(context, fid + "emb", { "tools" : qUnion([body, logo, boxer]), "operationType" : BooleanOperationType.UNION });

    if (!labels)
        return;
    const up = localExtrude(context, fid + "up", panelCs(0, 0), 0.5, -0.3, function(sk is Sketch)
        {
            const txt = ["SA", "SB", "S1", "S2", "SC", "SD", "T4", "T3", "T2", "T1"];
            const xs = [-74.4, -53.5, -40.5, 40.5, 53.5, 74.4, -44.5, -13.5, 13.5, 44.5];
            const ys = [53.8, 61, 70, 70, 61, 53.8, -13.5, -5, -5, -13.5];
            for (var i = 0; i < size(txt); i += 1)
            {
                skLabel(sk, "u" ~ i, txt[i], xs[i], ys[i], 3.0, false);
            }
        }, true);
    const lowCs = panelCs(0, -18.6);
    const low = localExtrude(context, fid + "low", lowCs, 0.5, -0.3, function(sk is Sketch)
        {
            for (var i = 0; i < 6; i += 1)
            {
                skLabel(sk, "n" ~ i, "" ~ (i + 1), -34.25 + 13.7 * i, 0, 2.2, false);
            }
        }, true);
    cutBody(context, fid + "eng", body, qUnion([up, low]));
}

// ================================================================ helpers

function toggle2Angle(p is BoxerToggle2) returns ValueWithUnits
{
    return p == BoxerToggle2.UP ? -20 * degree : 20 * degree;
}

function toggle3Angle(p is BoxerToggle3) returns ValueWithUnits
{
    return p == BoxerToggle3.UP ? -20 * degree : (p == BoxerToggle3.MID ? 0 * degree : 20 * degree);
}

// Frame on the front face at front-view position (x, y); z axis = panel normal.
function panelCs(x is number, y is number) returns CoordSystem
{
    if (y >= FOLD_Y)
        return coordSystem(pt(x, y, 0), vector(1, 0, 0), vector(0, 0, 1));
    return coordSystem(pt(x, y, -(FOLD_Y - y) * tan(TILT)), vector(1, 0, 0), vector(0, -sin(TILT), cos(TILT)));
}

// Frame on the top edge (flat top, or the R26 shoulder) at front-view x and depth z.
function topMount(x is number, zM is number) returns CoordSystem
{
    const ax = abs(x);
    if (ax <= 63)
        return coordSystem(pt(x, 78, zM), vector(1, 0, 0), vector(0, 1, 0));
    const s = x > 0 ? 1 : -1;
    const sa = (ax - 63) / 26;
    const ca = sqrt(1 - sa * sa);
    return coordSystem(pt(s * (63 + 26 * sa), 52 + 26 * ca, zM), vector(ca, -s * sa, 0), vector(s * sa, ca, 0));
}

function pt(x is number, y is number, z is number) returns Vector
{
    return vector(x, y, z) * millimeter;
}

function v2(x is number, y is number) returns Vector
{
    return vector(x, y) * millimeter;
}

function yAxisOf(cs is CoordSystem) returns Vector
{
    return cross(cs.zAxis, cs.xAxis);
}

function lp(cs is CoordSystem, x is number, y is number, z is number) returns Vector
{
    return cs.origin + (cs.xAxis * x + yAxisOf(cs) * y + cs.zAxis * z) * millimeter;
}

function lplane(cs is CoordSystem, z is number) returns Plane
{
    return plane(lp(cs, 0, 0, z), cs.zAxis, cs.xAxis);
}

function scalePts(pts is array, sx is number, sy is number) returns array
{
    var out = [];
    for (var p in pts)
        out = append(out, [p[0] * sx, p[1] * sy]);
    return out;
}

function mirrorPts(pts is array) returns array
{
    var out = [];
    for (var i = size(pts) - 1; i >= 0; i -= 1)
        out = append(out, [-pts[i][0], pts[i][1]]);
    return out;
}

function skPoly(sk is Sketch, nm is string, pts is array)
{
    const n = size(pts);
    for (var i = 0; i < n; i += 1)
    {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        skLineSegment(sk, nm ~ i, { "start" : v2(a[0], a[1]), "end" : v2(b[0], b[1]) });
    }
}

// Rounded rectangle centred at (cx, cy); r is clamped so a stadium / circle also works.
function skRRect(sk is Sketch, nm is string, cx is number, cy is number, w is number, h is number, r is number)
{
    const hw = w / 2;
    const hh = h / 2;
    const rr = min(r, min(hw, hh));
    const ex = hw - rr;
    const ey = hh - rr;
    const tol = 1e-6;
    if (ex > tol)
    {
        skLineSegment(sk, nm ~ "b", { "start" : v2(cx - ex, cy - hh), "end" : v2(cx + ex, cy - hh) });
        skLineSegment(sk, nm ~ "t", { "start" : v2(cx + ex, cy + hh), "end" : v2(cx - ex, cy + hh) });
    }
    if (ey > tol)
    {
        skLineSegment(sk, nm ~ "r", { "start" : v2(cx + hw, cy - ey), "end" : v2(cx + hw, cy + ey) });
        skLineSegment(sk, nm ~ "l", { "start" : v2(cx - hw, cy + ey), "end" : v2(cx - hw, cy - ey) });
    }
    if (rr > tol)
    {
        const k = rr * sqrt(0.5);
        skArc(sk, nm ~ "a0", { "start" : v2(cx + ex, cy - hh), "mid" : v2(cx + ex + k, cy - ey - k), "end" : v2(cx + hw, cy - ey) });
        skArc(sk, nm ~ "a1", { "start" : v2(cx + hw, cy + ey), "mid" : v2(cx + ex + k, cy + ey + k), "end" : v2(cx + ex, cy + hh) });
        skArc(sk, nm ~ "a2", { "start" : v2(cx - ex, cy + hh), "mid" : v2(cx - ex - k, cy + ey + k), "end" : v2(cx - hw, cy + ey) });
        skArc(sk, nm ~ "a3", { "start" : v2(cx - hw, cy - ey), "mid" : v2(cx - ex - k, cy - ey - k), "end" : v2(cx - ex, cy - hh) });
    }
}

// Text roughly centred on (cx, cy) with cap height ~ 0.72 h (Open Sans, ~0.9 h advance for capitals).
function skLabel(sk is Sketch, nm is string, text is string, cx is number, cy is number, h is number, bold is boolean)
{
    const w = 0.9 * h * length(text);
    skText(sk, nm, { "text" : text, "fontName" : bold ? "OpenSans-Bold.ttf" : "OpenSans-Regular.ttf",
                "firstCorner" : v2(cx - w / 2, cy - 0.36 * h), "secondCorner" : v2(cx + w / 2, cy + 0.64 * h) });
}

function sketchExtrude(context is Context, fid is Id, pl is Plane, depth is number, drawFn is function, filterInner is boolean) returns Query
{
    const sk = newSketchOnPlane(context, fid + "sk", { "sketchPlane" : pl });
    drawFn(sk);
    skSolve(sk);
    opExtrude(context, fid + "ex", {
                "entities" : qSketchRegion(fid + "sk", filterInner),
                "direction" : depth < 0 ? pl.normal * -1 : pl.normal,
                "endBound" : BoundingType.BLIND,
                "endDepth" : abs(depth) * millimeter });
    return qCreatedBy(fid + "ex", EntityType.BODY);
}

function localExtrude(context is Context, fid is Id, cs is CoordSystem, z0 is number, z1 is number, drawFn is function, filterInner is boolean) returns Query
{
    return sketchExtrude(context, fid, lplane(cs, z0), z1 - z0, drawFn, filterInner);
}

function lcyl(context is Context, fid is Id, cs is CoordSystem, x is number, y is number, z0 is number, z1 is number, r is number) returns Query
{
    fCylinder(context, fid, { "bottomCenter" : lp(cs, x, y, z0), "topCenter" : lp(cs, x, y, z1), "radius" : r * millimeter });
    return qCreatedBy(fid, EntityType.BODY);
}

function faceAt(body is Query, p is Vector) returns Query
{
    return qContainsPoint(qOwnedByBody(body, EntityType.FACE), p);
}

function edgeAt(body is Query, p is Vector) returns Query
{
    return qContainsPoint(qOwnedByBody(body, EntityType.EDGE), p);
}

function faceEdges(f is Query) returns Query
{
    return qAdjacent(f, AdjacencyType.EDGE, EntityType.EDGE);
}

function filletEdges(context is Context, fid is Id, edges is Query, r is number)
{
    opFillet(context, fid, { "entities" : edges, "radius" : r * millimeter });
}

function cutBody(context is Context, fid is Id, target is Query, tools is Query)
{
    opBoolean(context, fid, { "tools" : tools, "targets" : target, "operationType" : BooleanOperationType.SUBTRACTION });
}

function unite(context is Context, fid is Id, a is Query, b is Query)
{
    opBoolean(context, fid, { "tools" : qUnion([a, b]), "operationType" : BooleanOperationType.UNION });
}

function finishPart(context is Context, q is Query, name is string, c is Color)
{
    setProperty(context, { "entities" : q, "propertyType" : PropertyType.NAME, "value" : name });
    setProperty(context, { "entities" : q, "propertyType" : PropertyType.APPEARANCE, "value" : c });
}

// Mate connector at the pivot (built in the neutral pose), then move part + connector together.
function poseWithMc(context is Context, fid is Id, part is Query, mcCs is CoordSystem, T is Transform)
{
    opMateConnector(context, fid + "mc", { "coordSystem" : mcCs, "owner" : part });
    opTransform(context, fid + "tf", { "bodies" : qUnion([part, qCreatedBy(fid + "mc", EntityType.BODY)]), "transform" : T });
}
