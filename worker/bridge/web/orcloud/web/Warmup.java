package orcloud.web;

import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.SAXParserFactory;
import javax.xml.transform.TransformerFactory;

/**
 * Initialises Java's XML machinery on one thread before OpenRocket starts its background loaders.
 * Under CheerpJ, two threads initialising it at once fails at random.
 */
public final class Warmup {
	private Warmup() {
	}

	public static void xml() throws Exception {
		SAXParserFactory sax = SAXParserFactory.newInstance();
		sax.setNamespaceAware(true);
		sax.newSAXParser().getXMLReader();
		DocumentBuilderFactory.newInstance().newDocumentBuilder();
		TransformerFactory.newInstance().newTransformer();
	}
}
