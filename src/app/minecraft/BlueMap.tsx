export default function BlueMap() {
  const mapUrl = `${process.env.PAGES_BASE_PATH || ""}/bluemap/`;

  return (
    <section aria-label="Minecraft world map" className="my-6 space-y-3 px-4 sm:px-6">
      <p>
        Explore the Overworld in 3D. The map shows the latest completed snapshot.
        {" "}
        <a className="underline underline-offset-4" href={mapUrl} target="_blank" rel="noopener noreferrer">
          Open full map
        </a>
      </p>
      <iframe
        src={mapUrl}
        title="BlueMap 3D map of the Minecraft Overworld"
        className="block h-[75vh] min-h-[480px] w-full rounded-lg border border-current sm:min-h-[600px]"
        allow="fullscreen"
        allowFullScreen
      />
    </section>
  );
}
