import Image from "next/image";

export default function Home() {
    return (
        <main className="flex min-h-screen flex-col items-center justify-center bg-yellow-100 dark:bg-yellow-900 p-10 text-center">
            <div className="max-w-xl space-y-6">
                <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-yellow-800 dark:text-yellow-200">
                    🚧 Under Construction 🚧
                </h1>
                <p className="text-lg text-yellow-700 dark:text-yellow-300">
                    Currently being hammered together with love, TypeScript, and some duct tape.
                </p>
                <p className="text-sm text-yellow-600 dark:text-yellow-400">
                    Check back soon for something less chaotic and more complete.
                </p>

                <div className="border-4 border-dashed border-yellow-600 dark:border-yellow-400 p-6 rounded-lg mt-10">
                    <p className="text-yellow-700 dark:text-yellow-200 font-mono">
                        [Status: 1% Done. There&apos;s a header. That counts.]
                    </p>
                </div>
            </div>
        </main>
    );
}
