// =============================================================================
// ATB Battle Engine — deterministic RNG
// -----------------------------------------------------------------------------
// C# port of src/lib/atb/rng.ts (mulberry32). Pure, dependency-free.
//
// CRITICAL: this port must be bit-for-bit reproducible — the same seed MUST
// yield the identical float sequence as the TypeScript reference. See the
// port-notes flags F-RNG-1..F-RNG-4 referenced inline below.
// =============================================================================

using System;
using System.Collections.Generic;

namespace DeNelle.BattleATB.Engine
{
    /// <summary>
    /// A serialisable RNG. <see cref="Seed"/> is the live cursor — advancing it
    /// is what makes the engine deterministic *and* resumable: snapshot the
    /// seed, restore it, replay identically.
    ///
    /// F-RNG-1 / F-RNG-4: <see cref="Seed"/> MUST be a <c>uint</c>, and
    /// <see cref="Rng"/> MUST be a shared mutable reference type — TS mutates
    /// <c>rng.seed</c> through aliased references, so a struct would fork the
    /// stream.
    /// </summary>
    public sealed class Rng
    {
        /// <summary>The live PRNG state / cursor (unsigned 32-bit).</summary>
        public uint Seed;
    }

    /// <summary>Deterministic mulberry32 PRNG + derived helpers.</summary>
    public static class RngOps
    {
        /// <summary>
        /// Create an RNG from a 32-bit unsigned integer seed.
        /// TS does <c>seed &gt;&gt;&gt; 0</c> (ToUint32); <c>unchecked((uint)seed)</c>
        /// is exact for the non-negative 32-bit integer seeds this engine uses.
        /// </summary>
        public static Rng CreateRng(int seed)
        {
            unchecked
            {
                return new Rng { Seed = (uint)seed };
            }
        }

        /// <summary>Overload taking an already-unsigned seed.</summary>
        public static Rng CreateRng(uint seed) => new Rng { Seed = seed };

        /// <summary>
        /// Advance the RNG and return a float in [0, 1). Mutates <c>rng.Seed</c>.
        ///
        /// F-RNG-2: the whole body MUST run inside <c>unchecked</c> so the
        /// multiplies/adds wrap mod 2^32 instead of throwing — this reproduces
        /// JS <c>Math.imul</c> + ToUint32 exactly.
        /// F-RNG-3: the divisor must be a <c>double</c> literal (4294967296.0).
        /// </summary>
        public static double RngNext(Rng rng)
        {
            unchecked
            {
                // let t = (rng.seed = (rng.seed + 0x6d2b79f5) >>> 0);
                uint t = (rng.Seed = rng.Seed + 0x6D2B79F5u);
                // t = Math.imul(t ^ (t >>> 15), t | 1);
                t = (t ^ (t >> 15)) * (t | 1u);
                // t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                t ^= t + (t ^ (t >> 7)) * (t | 61u);
                // return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
                return (t ^ (t >> 14)) / 4294967296.0;
            }
        }

        /// <summary>A uniform integer in [min, max] inclusive.</summary>
        public static int RngInt(Rng rng, int min, int max)
        {
            return min + (int)Math.Floor(RngNext(rng) * (max - min + 1));
        }

        /// <summary>True with probability <paramref name="p"/> (0..1).</summary>
        public static bool RngChance(Rng rng, double p)
        {
            return RngNext(rng) < p;
        }

        /// <summary>
        /// Pick a uniformly-random element, or null when the list is empty.
        /// </summary>
        public static T RngPick<T>(Rng rng, IReadOnlyList<T> list) where T : class
        {
            if (list.Count == 0) return null;
            return list[RngInt(rng, 0, list.Count - 1)];
        }
    }
}
